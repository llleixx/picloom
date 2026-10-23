import type {
  CleanupItem,
  CleanupJob,
  Persistence,
  Repositories,
} from "../persistence/port";
import { entity } from "../persistence/port";
import { AppError, requireValue } from "./errors";
import { Mutex } from "./concurrency";
import type { Files } from "./files";

/** Durable, fixed replica snapshots. Storage operations stay in the shared file/task workflow. */
export class SourceCleanups {
  private mutex = new Mutex();
  private runningOffsets = new Map<string, number>();
  constructor(
    private db: Persistence,
    private files: Files,
  ) {}
  private async source(r: Repositories, id: string) {
    const source = requireValue(await r.instance(id));
    if (source.kind !== "storage")
      throw new AppError("NOT_FOUND", "Storage source not found", 404);
  }
  async preview(sourceId: string) {
    return this.db.read(async (r) => {
      await this.source(r, sourceId);
      return {
        ...(await r.cleanupPreview(sourceId)),
        groups: (await r.instanceReferences(sourceId)).filter(
          (ref) => ref.type === "group",
        ),
      };
    });
  }
  async submit(
    sourceId: string,
    mode: CleanupJob["mode"] = "delete",
    includeLast = true,
  ) {
    return this.mutex.run(() =>
      this.db.transaction(async (r) => {
        await this.source(r, sourceId);
        const active = (await r.activeCleanups()).find(
          (job) => job.source_id === sourceId,
        );
        if (active) return active;
        if (
          (await r.instanceReferences(sourceId)).some(
            (ref) => ref.type === "group",
          )
        )
          throw new AppError(
            "SOURCE_IN_USE",
            "Remove this source from Storage Groups first",
            409,
          );
        const job: CleanupJob = {
          ...entity(),
          source_id: sourceId,
          mode,
          include_last: includeLast,
          status: "active",
        };
        await r.insertCleanupJob(job);
        for (const replica of await r.cleanupTargets(sourceId))
          await r.insertCleanupItem({
            ...entity(),
            job_id: job.id,
            file_id: replica.file_id,
            replica_id: replica.id,
            status: "pending",
            whole_file: false,
            error: null,
          });
        return job;
      }),
    );
  }
  async latest(sourceId: string) {
    return this.db.read(async (r) => {
      await this.source(r, sourceId);
      return r.latestCleanup(sourceId);
    });
  }
  async detail(sourceId: string, jobId: string, limit = 25, offset = 0) {
    return this.db.read(async (r) => {
      const job = requireValue(await r.cleanupJob(jobId));
      if (job.source_id !== sourceId)
        throw new AppError("NOT_FOUND", "Cleanup not found", 404);
      return {
        job,
        counts: await r.cleanupCounts(jobId),
        items: await r.cleanupItems(jobId, limit, offset),
        remaining: await r.instanceReplicaCount(sourceId),
        groups: (await r.instanceReferences(sourceId)).filter(
          (ref) => ref.type === "group",
        ),
      };
    });
  }
  async retry(sourceId: string, jobId: string) {
    return this.mutex.run(async () => {
      const detail = await this.detail(sourceId, jobId);
      if (
        (await this.db.read((r) => r.activeCleanups())).some(
          (other) => other.source_id === sourceId && other.id !== jobId,
        )
      )
        throw new AppError("CONFLICT", "Another cleanup is active", 409);
      // Reuse original tasks, including their attempts/manual retry semantics.
      for (let offset = 0; ; offset += 50) {
        const items = await this.db.read((r) =>
          r.cleanupItems(jobId, 50, offset, ["failed"]),
        );
        if (!items.length) break;
        for (const item of items) {
          if (detail.job.mode !== "delete") continue;
          const tasks = await this.db.read((r) => r.tasks(item.file_id));
          for (const task of tasks) {
            if (
              task.kind !== "delete" ||
              task.status !== "failed" ||
              (!item.whole_file && task.replica_id !== item.replica_id)
            )
              continue;
            try {
              await this.files.tasks.retry(task.id);
            } catch {
              /* Item processing reports the current error. */
            }
          }
        }
      }
      return this.db.transaction(async (r) => {
        const job = requireValue(await r.cleanupJob(jobId));
        if (
          (await r.activeCleanups()).some(
            (other) => other.source_id === sourceId && other.id !== jobId,
          )
        )
          throw new AppError("CONFLICT", "Another cleanup is active", 409);
        await r.retryCleanupItems(jobId);
        job.status = "active";
        await r.saveCleanupJob(job);
        return job;
      });
    });
  }
  private async save(item: CleanupItem) {
    await this.db.transaction((r) => r.saveCleanupItem(item));
  }
  private async process(job: CleanupJob, item: CleanupItem) {
    try {
      const state = await this.db.read(async (r) => ({
        file: requireValue(await r.file(item.file_id)),
        replica: requireValue(await r.replica(item.replica_id)),
      }));
      if (item.status === "pending") {
        if (
          job.mode === "delete" &&
          ["deleting", "delete_failed"].includes(state.file.status)
        )
          item.whole_file = true;
        if (state.replica.status === "deleted" && !item.whole_file)
          item.status = "success";
        else if (job.mode === "detach") {
          item.whole_file = (
            await this.files.detach(
              item.file_id,
              item.replica_id,
              job.include_last,
            )
          ).whole;
          item.status = "success";
        } else {
          // A prior submission or interrupted acceptance may already have scheduled deletion.
          if (
            !item.whole_file &&
            !["delete_pending", "deleting", "delete_failed"].includes(
              state.replica.status,
            )
          )
            item.whole_file = (
              await this.files.deleteReplica(
                item.file_id,
                item.replica_id,
                job.include_last,
              )
            ).whole;
          item.status = "running";
        }
        item.error = null;
        await this.save(item);
      }
      if (item.status !== "running") return;
      const current = await this.db.read(async (r) => ({
        file: requireValue(await r.file(item.file_id)),
        replica: requireValue(await r.replica(item.replica_id)),
        tasks: await r.tasks(item.file_id),
      }));
      if (
        item.whole_file
          ? current.file.status === "deleted"
          : current.replica.status === "deleted"
      )
        item.status = "success";
      else {
        const tasks = current.tasks.filter(
          (task) =>
            task.kind === "delete" &&
            (item.whole_file || task.replica_id === item.replica_id),
        );
        if (
          !tasks.some((task) => ["pending", "running"].includes(task.status)) &&
          (tasks.some((task) => task.status === "failed") ||
            (item.whole_file
              ? current.file.status === "delete_failed"
              : current.replica.status === "delete_failed"))
        ) {
          item.status = "failed";
          item.error =
            tasks.find((task) => task.status === "failed")?.last_error ??
            "DELETE_FAILED";
        }
      }
      await this.save(item);
    } catch (error) {
      item.status =
        error instanceof AppError && error.code === "LAST_REPLICA"
          ? "kept"
          : "failed";
      item.error = error instanceof AppError ? error.code : "INTERNAL";
      await this.save(item);
    }
  }
  async tick() {
    await this.mutex.run(async () => {
      for (const job of await this.db.read((r) => r.activeCleanups())) {
        // Keep each maintenance pass bounded; no browser-driven batches or bucket enumeration.
        const countsBefore = await this.db.read((r) => r.cleanupCounts(job.id));
        const offset =
          (this.runningOffsets.get(job.id) ?? 0) %
          Math.max(countsBefore.running, 1);
        const running = await this.db.read((r) =>
          r.cleanupItems(job.id, 50, offset, ["running"]),
        );
        this.runningOffsets.set(job.id, offset + running.length);
        const pending = await this.db.read((r) =>
          r.cleanupItems(job.id, 50, 0, ["pending"]),
        );
        for (const item of [...running, ...pending])
          await this.process(job, item);
        await this.db.transaction(async (r) => {
          const counts = await r.cleanupCounts(job.id);
          if (!counts.pending && !counts.running) {
            this.runningOffsets.delete(job.id);
            job.status = "finished";
            await r.saveCleanupJob(job);
          }
        });
      }
    });
  }
}
