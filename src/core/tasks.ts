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
import { PluginError, type Context } from "../plugins/api";
import type { Settings } from "../config";
import { AppError, Conflict, requireValue } from "./errors";
import { InFlight, Mutex } from "./concurrency";
import { fileInput, scopedInput, publicPath } from "../infra/files";
import type { ImageCache } from "./cache";
const terminal = (t: Task) => ["success", "cancelled"].includes(t.status);
export class TaskExecutor {
  private stopping = false;
  private mutex = new Mutex();
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
      task.attempts = 0;
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
          const recovered = await this.recoverReplica(file, replica);
          if (recovered.status === "unknown") continue;
          replica.status =
            recovered.status === "stored" ? "ready" : "cancelled";
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
            replica.status = "cancelled";
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
          if (
            ["writing", "write_unknown", "cancelled", "deleted"].includes(
              replica.status,
            )
          )
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
      state.replicas.some((r) => !["deleted", "cancelled"].includes(r.status))
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
                },
                { ...ctx, data },
              );
              if (
                !result ||
                !["pass", "block", "delete"].includes(result.status)
              )
                throw new AppError("PLUGIN_RESULT", "Invalid Post-save result");
              if (result.details !== undefined) {
                try {
                  if (
                    !result.details ||
                    typeof result.details !== "object" ||
                    Array.isArray(result.details)
                  )
                    throw new Error();
                  assertJson(result.details);
                  results.push({
                    stepId: step.id,
                    pluginId: stage.record.plugin_id,
                    pluginVersion: stage.record.plugin_version,
                    completedAt: Date.now(),
                    status: result.status,
                    details: JSON.parse(JSON.stringify(result.details)),
                  });
                  if (Buffer.byteLength(JSON.stringify(results)) > 64 * 1024)
                    throw new Error();
                } catch {
                  throw new PluginError(
                    "PROCESSING_RESULT_INVALID",
                    "Processing results must be JSON objects totaling at most 64 KiB",
                  );
                }
              }
              if (result.status !== "pass") {
                decision = result.status;
                break;
              }
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
              throw new PluginError(
                "WRITE_UNKNOWN",
                "写入结果仍未知",
                true,
                "unknown",
              );
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
          !(
            error instanceof AppError &&
            ["TEMP_MISSING", "PIPELINE_MISSING"].includes(error.code)
          ) &&
          (!isPluginError(error) || error.retryable);
        t.status = cancelled
          ? "cancelled"
          : retryable && t.attempts < this.config.retryLimit
            ? "pending"
            : "failed";
        t.next_run_at =
          t.status === "pending" ? Date.now() + 1000 * 2 ** t.attempts : null;
        t.last_error = cancelled
          ? null
          : error instanceof AppError
            ? error.code
            : isPluginError(error) &&
                [
                  "TELEGRAM_AUTH",
                  "TELEGRAM_SIZE",
                  "TELEGRAM_DELETE_UNAVAILABLE",
                  "OPENLIST_AUTH",
                  "NODEIMAGE_AUTH",
                  "NODEIMAGE_DELETE_UNAVAILABLE",
                  "WEBHOOK_HTTP",
                  "WEBHOOK_NETWORK",
                  "PROCESSING_RESULT_INVALID",
                  "TENCENT_AUTH",
                  "TENCENT_INPUT",
                  "TENCENT_CONTENT_SIZE",
                  "TENCENT_IMAGE_DOWNLOAD",
                  "TENCENT_NETWORK",
                  "TENCENT_SERVICE",
                  "TENCENT_RESPONSE",
                ].includes(error.code)
              ? error.code
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
  async sweep() {
    await this.mutex.run(async () => {
      const candidates = await this.db.read(async (r) => [
        ...(await r.filesInStates(["failed", "deleting"])),
        ...(await r.filesNeedingCleanup()),
      ]);
      for (const file of [
        ...new Map(candidates.map((f) => [f.id, f])).values(),
      ])
        try {
          await this.cleanup(file);
        } catch {
          console.error(
            JSON.stringify({ event: "recovery_pending", fileId: file.id }),
          );
        }
      const due = await this.db.read((r) => r.dueTasks(Date.now()));
      let next = 0;
      await Promise.all(
        Array.from(
          { length: Math.min(this.config.taskConcurrency, due.length) },
          async () => {
            while (!this.stopping) {
              const task = due[next++];
              if (!task) return;
              try {
                await this.run(task.id);
              } catch {
                console.error(
                  JSON.stringify({
                    event: "task_execution_failed",
                    taskId: task.id,
                  }),
                );
              }
            }
          },
        ),
      );
      for (const file of await this.db.read((r) => r.filesNeedingCleanup())) {
        try {
          await this.cleanup(file);
        } catch {
          console.error(
            JSON.stringify({ event: "recovery_pending", fileId: file.id }),
          );
        }
      }
    });
  }
  async close() {
    this.stopping = true;
    for (const item of this.controllers.values()) item.controller.abort();
    await this.mutex.run(async () => {});
  }
}
