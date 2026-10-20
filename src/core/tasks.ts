import { pluginErrorCode } from "./errors";
import type { TemporarySpace } from "../infra/temporary-space";
import { isPluginError } from "../../plugin-sdk/api";
import type { ProcessingResult } from "../../shared/api";
import { assertJson, pipelineData } from "./pipeline-data";
import { join } from "node:path";
import type {
  Persistence,
  Task,
  FileRecord,
  Replica,
} from "../persistence/port";
import { entity } from "../persistence/port";
import type { PluginManager } from "../plugins/manager";
import { type Context } from "../plugins/api";
import type { Settings } from "../config";
import { AppError, Conflict, requireValue } from "./errors";
import { InFlight, Mutex } from "./concurrency";
import { fileInput, scopedInput, publicPath } from "../infra/files";
import type { ImageCache } from "./cache";
const terminal = (t: Task) =>
  ["success", "cancelled"].includes(t.status) ||
  (t.kind === "action" && t.status === "failed");
const dispositionRank = { pass: 0, block: 1, delete: 2 } as const;
export class TaskExecutor {
  private stopping = false;
  private paused = false;
  private dispatchRequested = false;
  private dispatching?: Promise<string[]>;
  private mutex = new Mutex();
  private cleanupMutex = new Mutex();
  private cleaning = new Set<string>();
  private forgetting = new Set<string>();
  private running = new Map<
    string,
    { fileId: string; promise: Promise<void> }
  >();
  private controllers = new Map<
    string,
    { fileId: string; kind: Task["kind"]; controller: AbortController }
  >();
  constructor(
    private db: Persistence,
    private plugins: PluginManager,
    private config: Settings,
    private flight: InFlight,
    private cache: ImageCache,
    private temporary: TemporarySpace,
    private beforeDelete?: () => Promise<void>,
  ) {}
  cancel(fileId: string) {
    for (const item of this.controllers.values())
      if (item.fileId === fileId && item.kind !== "delete")
        item.controller.abort();
  }
  async forget(fileId: string) {
    // Wait for an existing recovery pass, then gate this file only. Do not hold
    // either scheduling lock while waiting for plugin calls or disk cleanup.
    await this.cleanupMutex.run(() =>
      this.mutex.run(async () => {
        if (this.stopping || this.forgetting.has(fileId))
          throw new Conflict("File cleanup is already in progress");
        const file = requireValue(await this.db.read((r) => r.file(fileId)));
        if (file.status !== "deleting")
          throw new Conflict("Only files pending deletion can be removed");
        this.forgetting.add(fileId);
      }),
    );
    try {
      for (const item of this.controllers.values())
        if (item.fileId === fileId) item.controller.abort();
      await Promise.all(
        [...this.running.values()]
          .filter((task) => task.fileId === fileId)
          .map((task) => task.promise),
      );
      await this.flight.wait(fileId);
      const file = requireValue(await this.db.read((r) => r.file(fileId)));
      if (file.temp_path)
        await this.temporary.remove(
          join(this.config.root, "temp", file.temp_path),
        );
      await this.cache.remove(fileId);
      await this.db.transaction(async (r) => {
        const current = requireValue(await r.file(fileId));
        if (current.status !== "deleting")
          throw new Conflict("File state changed");
        await r.removeFile(fileId);
      });
    } finally {
      this.forgetting.delete(fileId);
      this.refill();
    }
  }
  private context(signal: AbortSignal): Context {
    return {
      signal,
      requestId: crypto.randomUUID(),
      log: (event) =>
        console.info(JSON.stringify({ event: event.slice(0, 120) })),
    };
  }
  async retry(id: string) {
    await this.db.transaction(async (r) => {
      const task = requireValue(await r.task(id)),
        file = requireValue(await r.file(task.file_id));
      if (
        task.status !== "failed" ||
        task.kind !== "delete" ||
        !["ready", "blocked", "deleting"].includes(file.status)
      )
        throw new Conflict("Task cannot be retried");
      task.status = "pending";
      task.manual_retry = true;
      task.next_run_at = Date.now();
      task.last_error = null;
      await r.saveTask(task);
    });
  }
  async recoverReplica(file: FileRecord, replica: Replica) {
    const task = (await this.db.read((r) => r.tasks(file.id))).find(
      (t) => t.kind === "write" && t.replica_id === replica.id,
    );
    const lease = this.plugins.acquire(replica.storage_instance_id, "storage");
    try {
      const signal = AbortSignal.timeout(120_000);
      const result = (await lease.runtime.recoverWrite?.(
        {
          operationId: task?.id ?? `initial:${replica.id}`,
          fileId: file.id,
          storageKey: file.storage_key,
          expectedSize: file.byte_size!,
          locator: replica.locator_json,
        },
        this.context(signal),
      )) ?? { status: "unknown" as const };
      signal.throwIfAborted();
      return result;
    } finally {
      await lease.release();
    }
  }
  private async releaseTemporary(fileId: string) {
    const file = requireValue(await this.db.read((r) => r.file(fileId)));
    if (!file.temp_path || file.status === "preparing") return;
    const needsSource = (tasks: Task[]) =>
      tasks.some(
        (task) =>
          task.kind !== "delete" &&
          ["pending", "running"].includes(task.status),
      );
    if (needsSource(await this.db.read((r) => r.tasks(fileId)))) return;
    await this.flight.wait(fileId);
    await this.temporary.remove(join(this.config.root, "temp", file.temp_path));
    await this.db.transaction(async (r) => {
      const current = requireValue(await r.file(fileId));
      current.temp_path = null;
      current.temp_status = "cleaned";
      await r.saveFile(current, current.status);
    });
  }
  private async cleanup(file: FileRecord) {
    await this.releaseTemporary(file.id);
    if (file.status === "failed" || file.status === "deleting") {
      this.cancel(file.id);
      await this.flight.wait(file.id);
      for (const replica of await this.db.read((r) => r.replicas(file.id))) {
        if (["writing", "write_unknown"].includes(replica.status)) {
          const recovered = await this.recoverReplica(file, replica).catch(
            () => {
              console.error(
                JSON.stringify({
                  event: "replica_recovery_failed",
                  fileId: file.id,
                  replicaId: replica.id,
                }),
              );
              return { status: "unknown" as const };
            },
          );
          if (recovered.status === "unknown") continue;
          replica.status = recovered.status === "stored" ? "ready" : "deleted";
          if (recovered.status === "stored")
            replica.locator_json = recovered.locator ?? null;
          await this.db.transaction(async (r) => {
            await r.saveReplica(replica);
            for (const task of await r.tasks(file.id))
              if (
                task.kind === "write" &&
                task.replica_id === replica.id &&
                !terminal(task)
              ) {
                task.status =
                  recovered.status === "stored" ? "success" : "cancelled";
                task.last_error = null;
                task.next_run_at = null;
                await r.saveTask(task);
              }
          });
        }
      }
      await this.db.transaction(async (r) => {
        const f = requireValue(await r.file(file.id)),
          replicas = await r.replicas(f.id),
          tasks = await r.tasks(f.id);
        if (f.status === "failed") {
          f.status = "deleting";
          await r.saveFile(f, "failed");
        }
        for (const task of tasks)
          if (task.kind === "action" && !terminal(task)) {
            task.status = "cancelled";
            task.next_run_at = null;
            task.last_error = null;
            await r.saveTask(task);
          }
        for (const replica of replicas) {
          if (["pending", "write_failed"].includes(replica.status)) {
            replica.status = "deleted";
            await r.saveReplica(replica);
            for (const task of tasks)
              if (
                task.kind === "write" &&
                task.replica_id === replica.id &&
                !terminal(task)
              ) {
                task.status = "cancelled";
                task.next_run_at = null;
                await r.saveTask(task);
              }
          }
          if (["writing", "write_unknown", "deleted"].includes(replica.status))
            continue;
          if (tasks.some((t) => t.replica_id === replica.id && !terminal(t)))
            continue;
          replica.status = "delete_pending";
          await r.saveReplica(replica);
          await r.insertTask({
            ...entity(),
            kind: "delete",
            file_id: f.id,
            replica_id: replica.id,
            pipeline_id: null,
            status: "pending",
            attempts: 0,
            next_run_at: Date.now(),
            last_error: null,
          });
        }
      });
    }
    await this.releaseTemporary(file.id);
    const current = requireValue(await this.db.read((r) => r.file(file.id)));
    if (!["ready", "blocked", "deleting"].includes(current.status)) return;
    const state = await this.db.read(async (r) => ({
      tasks: await r.tasks(file.id),
      replicas: await r.replicas(file.id),
    }));
    if (
      state.tasks.some((t) => !terminal(t)) ||
      state.replicas.some((r) =>
        ["writing", "write_unknown"].includes(r.status),
      )
    )
      return;
    if (
      current.status === "deleting" &&
      state.replicas.some((r) => r.status !== "deleted")
    )
      return;
    await this.flight.wait(file.id);
    await this.db.transaction(async (r) => {
      const f = requireValue(await r.file(file.id));
      if ((await r.tasks(file.id)).some((t) => !terminal(t))) return;
      f.temp_path = null;
      f.temp_status = "cleaned";
      if (f.status === "deleting") {
        f.status = "deleted";
        f.deleted_at = Date.now();
      }
      await r.saveFile(f, current.status);
    });
    if (current.status === "deleting") await this.cache.remove(file.id);
  }
  private async run(id: string) {
    if (this.stopping) return;
    const state = await this.db.transaction(async (r) => {
      const task = requireValue(await r.task(id));
      if (task.status !== "pending" || task.next_run_at! > Date.now())
        return null;
      const file = requireValue(await r.file(task.file_id));
      if (
        task.kind === "delete"
          ? !["ready", "blocked", "deleting"].includes(file.status)
          : task.kind === "write"
            ? !["ready", "blocked"].includes(file.status)
            : file.status !== "ready"
      )
        return null;
      const replica = task.replica_id
        ? requireValue(await r.replica(task.replica_id))
        : null;
      task.status = "running";
      task.attempts++;
      await r.saveTask(task, "pending");
      return { task, file, replica };
    });
    if (!state) return;
    if (state.task.kind === "delete") await this.flight.wait(state.file.id);
    const { task, file, replica } = state,
      controller = new AbortController(),
      end = this.flight.enter(file.id);
    this.controllers.set(id, { fileId: file.id, kind: task.kind, controller });
    const timeout = setTimeout(
      () => controller.abort(new Error("Task timed out")),
      120_000,
    );
    let lease: ReturnType<PluginManager["acquire"]> | undefined;
    let activeStep: { id: string; name: string } | undefined;
    let decision: "pass" | "block" | "delete" = "pass";
    const results: ProcessingResult[] = [];
    let writeAttempted = false,
      previousWriteUnknown =
        !!replica && ["writing", "write_unknown"].includes(replica.status);
    try {
      if (this.stopping || this.forgetting.has(file.id)) controller.abort();
      controller.signal.throwIfAborted();
      const ctx = this.context(controller.signal);
      if (task.kind === "action") {
        const steps = await this.db.read(async (r) => {
          const pipeline = task.pipeline_id
            ? await r.pipeline(task.pipeline_id)
            : null;
          if (!pipeline || pipeline.kind !== "post_save")
            throw new AppError(
              "PIPELINE_MISSING",
              "Post-save pipeline was deleted",
            );
          return r.steps(pipeline.id);
        });
        const data = pipelineData();
        for (const step of steps) {
          activeStep = { id: step.id, name: step.id };
          controller.signal.throwIfAborted();
          const current = await this.db.read((r) => r.file(file.id));
          if (current?.status !== "ready")
            throw new AppError("FILE_DELETING", "File is no longer available");
          const stage = this.plugins.acquire(
            step.plugin_instance_id,
            "post_save",
          );
          activeStep.name = this.plugins.descriptor(stage.record).name;
          try {
            const path = file.temp_path
              ? join(this.config.root, "temp", file.temp_path)
              : null;
            if (!path || !(await Bun.file(path).exists()))
              throw new AppError("TEMP_MISSING", "Task source is missing");
            const scope = scopedInput(
              fileInput(path, {
                mimeType: file.mime_type,
                byteSize: file.byte_size,
                width: file.width,
                height: file.height,
              }),
              controller.signal,
            );
            try {
              const result = await stage.runtime.execute(
                {
                  operationId: `${id}:${step.id}`,
                  fileId: file.id,
                  publicPath: publicPath(file.public_prefix, file.logical_key),
                  url:
                    this.config.imageOrigin +
                    publicPath(file.public_prefix, file.logical_key),
                  file: scope.file,
                  currentStatus: decision,
                  previousResults: structuredClone(results),
                },
                { ...ctx, data },
              );
              controller.signal.throwIfAborted();
              if (
                !result ||
                !["pass", "block", "delete"].includes(result.status) ||
                (result.overrideStatus !== undefined &&
                  !["pass", "block", "delete"].includes(result.overrideStatus))
              )
                throw new AppError("PLUGIN_RESULT", "Invalid Post-save result");
              let completed: ProcessingResult;
              try {
                if (result.details !== undefined) {
                  if (
                    !result.details ||
                    typeof result.details !== "object" ||
                    Array.isArray(result.details)
                  )
                    throw new Error();
                  assertJson(result.details);
                }
                completed = {
                  stepId: step.id,
                  pluginId: stage.record.plugin_id,
                  pluginVersion: stage.record.plugin_version,
                  completedAt: Date.now(),
                  status: result.status,
                  ...(result.overrideStatus !== undefined
                    ? { overrideStatus: result.overrideStatus }
                    : {}),
                  ...(result.details !== undefined
                    ? { details: JSON.parse(JSON.stringify(result.details)) }
                    : {}),
                };
                if (
                  Buffer.byteLength(JSON.stringify([...results, completed])) >
                  64 * 1024
                )
                  throw new Error();
              } catch {
                throw new AppError(
                  "PROCESSING_RESULT_INVALID",
                  "Processing results must be JSON objects totaling at most 64 KiB",
                );
              }
              // Accept a step atomically only after its entire result is valid.
              results.push(completed);
              decision =
                completed.overrideStatus ??
                (dispositionRank[completed.status] > dispositionRank[decision]
                  ? completed.status
                  : decision);
            } finally {
              await scope.close();
            }
          } finally {
            await stage.release();
          }
        }
        activeStep = undefined;
        controller.signal.throwIfAborted();
      } else {
        lease = this.plugins.acquire(replica!.storage_instance_id, "storage");
        const storage = lease.runtime as import("../plugins/api").StoragePlugin;
        if (task.kind === "write") {
          let stored = false;
          if (["writing", "write_unknown"].includes(replica!.status)) {
            const result = await storage.recoverWrite?.(
              {
                operationId: id,
                fileId: file.id,
                storageKey: file.storage_key,
                expectedSize: file.byte_size!,
                locator: replica!.locator_json,
              },
              ctx,
            );
            if (!result || result.status === "unknown")
              throw new AppError("WRITE_UNKNOWN", "写入结果仍未知", 502);
            if (result.status === "stored") {
              replica!.locator_json = result.locator ?? null;
              stored = true;
            }
            if (result.status === "notStored") previousWriteUnknown = false;
          }
          if (!stored) {
            const path = file.temp_path
              ? join(this.config.root, "temp", file.temp_path)
              : null;
            if (!path || !(await Bun.file(path).exists()))
              throw new AppError("TEMP_MISSING", "任务暂存文件缺失");
            replica!.status = "writing";
            await this.db.transaction((r) => r.saveReplica(replica!));
            const scope = scopedInput(
              fileInput(path, {
                mimeType: file.mime_type,
                byteSize: file.byte_size,
                width: file.width,
                height: file.height,
              }),
              controller.signal,
            );
            try {
              controller.signal.throwIfAborted();
              writeAttempted = true;
              const result = await storage.write(
                {
                  operationId: id,
                  fileId: file.id,
                  storageKey: file.storage_key,
                  file: scope.file,
                },
                ctx,
              );
              replica!.locator_json = result.locator ?? null;
            } finally {
              await scope.close();
            }
          }
          replica!.status = "ready";
        } else {
          replica!.status = "deleting";
          await this.db.transaction((r) => r.saveReplica(replica!));
          await this.beforeDelete?.();
          await storage.delete(
            {
              operationId: id,
              storageKey: file.storage_key,
              locator: replica!.locator_json,
            },
            ctx,
          );
          replica!.status = "deleted";
        }
      }
      controller.signal.throwIfAborted();
      await this.db.transaction(async (r) => {
        const current = requireValue(await r.task(id));
        if (current.status !== "running") throw new Conflict();
        if (task.kind === "action") {
          const currentFile = requireValue(await r.file(file.id));
          if (currentFile.status !== "ready")
            throw new AppError("FILE_DELETING", "File is no longer available");
          if (decision !== "pass")
            currentFile.status = decision === "block" ? "blocked" : "deleting";
          currentFile.processing_results_json = results.length ? results : null;
          await r.saveFile(currentFile, "ready");
        }
        current.status = "success";
        current.last_error = null;
        current.next_run_at = null;
        if (replica) await r.saveReplica(replica);
        await r.saveTask(current, "running");
      });
      if (decision === "delete") this.cancel(file.id);
    } catch (error) {
      await this.db.transaction(async (r) => {
        const t = requireValue(await r.task(id)),
          f = requireValue(await r.file(file.id));
        if (t.status !== "running") return;
        const cancelled = t.kind === "action" && f.status === "deleting";
        // Never overwrite a concurrent user deletion. Keep completed decisions even
        // when a later plugin throws, times out or returns an invalid result.
        if (t.kind === "action" && f.status === "ready" && results.length) {
          if (decision !== "pass")
            f.status = decision === "block" ? "blocked" : "deleting";
          f.processing_results_json = results;
          await r.saveFile(f, "ready");
        }
        if (replica) {
          if (t.kind === "write")
            replica.status =
              !writeAttempted && !previousWriteUnknown
                ? "write_failed"
                : isPluginError(error) && error.outcome === "notApplied"
                  ? "write_failed"
                  : "write_unknown";
          else
            replica.status =
              isPluginError(error) && error.outcome === "notApplied"
                ? "delete_failed"
                : "delete_unknown";
          await r.saveReplica(replica);
        }
        const retryable =
          (t.kind !== "action" || decision === "pass") &&
          !(
            error instanceof AppError &&
            [
              "TEMP_MISSING",
              "PIPELINE_MISSING",
              "PROCESSING_RESULT_INVALID",
              "PLUGIN_RESULT",
            ].includes(error.code)
          ) &&
          (!isPluginError(error) || error.retryable);
        t.status = cancelled
          ? "cancelled"
          : !t.manual_retry && retryable && t.attempts < this.config.retryLimit
            ? "pending"
            : "failed";
        t.next_run_at =
          t.status === "pending" ? Date.now() + 1000 * 2 ** t.attempts : null;
        t.last_error = cancelled
          ? null
          : error instanceof AppError
            ? error.code
            : isPluginError(error)
              ? pluginErrorCode(error.code)
              : t.kind === "delete"
                ? "DELETE_FAILED"
                : t.kind === "write"
                  ? "WRITE_FAILED"
                  : "ACTION_FAILED";
        if (t.last_error && activeStep) {
          const failure = { code: t.last_error, step: activeStep };
          t.last_error = JSON.stringify(failure);
          console.error(
            JSON.stringify({
              event: "pipeline_failed",
              taskId: id,
              fileId: file.id,
              ...failure,
            }),
          );
        }
        await r.saveTask(t, "running");
        if (error instanceof AppError && error.code === "TEMP_MISSING") {
          f.temp_status = "missing";
          await r.saveFile(f, f.status);
        }
      });
      if (decision === "delete") this.cancel(file.id);
    } finally {
      clearTimeout(timeout);
      try {
        await lease?.release();
      } finally {
        this.controllers.delete(id);
        end();
      }
    }
  }
  // Concurrent completion notifications share one admission loop.
  dispatch(): Promise<string[]> {
    if (this.paused || this.stopping) return Promise.resolve([]);
    this.dispatchRequested = true;
    if (!this.dispatching) {
      this.dispatching = (async () => {
        const started: string[] = [];
        do {
          this.dispatchRequested = false;
          started.push(...(await this.dispatchOnce()));
        } while (this.dispatchRequested && !this.paused && !this.stopping);
        return started;
      })().finally(() => {
        this.dispatching = undefined;
        if (this.dispatchRequested) this.refill();
      });
    }
    return this.dispatching;
  }
  private refill() {
    void this.dispatch().catch(() => {
      console.error(JSON.stringify({ event: "task_dispatch_failed" }));
    });
  }
  // The lock protects admission only; plugin work runs outside it.
  private async dispatchOnce() {
    return this.mutex.run(async () => {
      if (this.paused || this.stopping) return [];
      const capacity = this.config.taskConcurrency - this.running.size;
      if (capacity <= 0) return [];
      const due = await this.db.read((r) =>
        r.dueTasks(Date.now(), {
          limit: capacity,
          excludedFiles: [...this.cleaning, ...this.forgetting],
          excludedTasks: [...this.running.keys()],
        }),
      );
      if (this.paused || this.stopping) return [];
      for (const task of due) {
        let completed = false;
        const promise = Promise.resolve()
          .then(() => this.run(task.id))
          .then(() => {
            completed = true;
          })
          .catch(() => {
            console.error(
              JSON.stringify({
                event: "task_execution_failed",
                taskId: task.id,
              }),
            );
          })
          .finally(() => {
            this.running.delete(task.id);
            // Unexpected persistence failures must not trigger their own immediate retry.
            if (completed) this.refill();
          });
        this.running.set(task.id, { fileId: task.file_id, promise });
      }
      return due.map((task) => task.id);
    });
  }
  async pause() {
    this.paused = true;
    await this.mutex.run(async () => {});
    await this.dispatching;
  }
  resume() {
    if (this.stopping) return;
    this.paused = false;
    this.refill();
  }
  async cleanupPending() {
    await this.cleanupMutex.run(async () => {
      if (this.stopping) return;
      const candidates = await this.db.read((r) => r.filesNeedingCleanup());
      for (const file of candidates) {
        const admitted = await this.mutex.run(async () => {
          if (this.stopping || this.forgetting.has(file.id)) return false;
          if (
            [...this.running.values()].some((task) => task.fileId === file.id)
          ) {
            if (file.status === "failed" || file.status === "deleting")
              this.cancel(file.id);
            return false;
          }
          this.cleaning.add(file.id);
          return true;
        });
        if (!admitted) continue;
        try {
          await this.cleanup(
            requireValue(await this.db.read((r) => r.file(file.id))),
          );
        } catch {
          console.error(
            JSON.stringify({ event: "recovery_pending", fileId: file.id }),
          );
        } finally {
          this.cleaning.delete(file.id);
        }
      }
    });
  }
  async drain() {
    while (this.dispatching || this.running.size) {
      await this.dispatching;
      await Promise.all([...this.running.values()].map((task) => task.promise));
    }
  }
  // Explicit startup/manual sweep keeps its await-until-finished semantics.
  async sweep() {
    await this.cleanupPending();
    await this.dispatch();
    await this.drain();
    await this.cleanupPending();
  }
  async close() {
    this.stopping = true;
    await this.pause();
    for (const item of this.controllers.values()) item.controller.abort();
    await this.drain();
    await this.cleanupMutex.run(async () => {});
  }
}
