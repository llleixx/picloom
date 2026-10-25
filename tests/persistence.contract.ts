import { organizationContract } from "./organization.contract";
import { describe, test, expect } from "bun:test";
import {
  entity,
  type Persistence,
  type User,
  type Instance,
  type Repositories,
  type FileRecord,
  type Task,
  type Replica,
} from "../src/persistence/port";
import { Conflict } from "../src/core/errors";
export function persistenceContract(
  name: string,
  open: () => Promise<{ db: Persistence; close(): Promise<void> }>,
) {
  organizationContract(name, open);
  describe(name, () => {
    test("task queues preserve eligibility and strict write tiers with deterministic ordering", async () => {
      const f = await open();
      try {
        const pipeline = {
          ...entity(),
          name: "Post-save",
          kind: "post_save" as const,
          config_version: 1,
        };
        await f.db.transaction((r) => r.insertPipeline(pipeline));
        async function add(
          kind: Task["kind"],
          status: FileRecord["status"],
          due: number,
          options: {
            ready?: boolean;
            attempts?: number;
            replicaStatus?: Replica["status"];
            created?: number;
          } = {},
        ) {
          const base = entity();
          const file: FileRecord = {
            ...base,
            guest_ip: null,
            owner_id: null,
            origin_kind: "upload",
            origin_user_id: null,
            upload_profile_id: null,
            storage_group_id: null,
            public_prefix: "/i/",
            logical_key: base.id + ".png",
            storage_key: base.id + ".png",
            mime_type: "image/png",
            byte_size: 10,
            width: 1,
            height: 1,
            status,
            temp_path: null,
            temp_status: "cleaned",
            last_error: null,
            processing_results_json: null,
          };
          const task: Task = {
            ...entity(),
            created_at: options.created ?? 10,
            kind,
            file_id: file.id,
            replica_id: null,
            pipeline_id: kind === "action" ? pipeline.id : null,
            status: "pending",
            attempts: options.attempts ?? 0,
            next_run_at: due,
            last_error: null,
          };
          await f.db.transaction(async (r) => {
            await r.insertFile(file);
            async function replica(status: Replica["status"]) {
              const source = {
                ...instance(),
                kind: "storage" as const,
                stage: null,
              };
              await r.saveInstance(source);
              const value: Replica = {
                ...entity(),
                file_id: file.id,
                storage_instance_id: source.id,
                status,
                locator_json: null,
              };
              await r.insertReplica(value);
              return value;
            }
            if (kind !== "action")
              task.replica_id = (
                await replica(
                  options.replicaStatus ??
                    (kind === "write" ? "pending" : "delete_pending"),
                )
              ).id;
            if (options.ready) await replica("ready");
            await r.insertTask(task);
          });
          return { file, task };
        }
        const old = await add("write", "ready", 1);
        const publishedCopy = await add("write", "preparing", 2, {
          ready: true,
        });
        const admitted = await add("write", "preparing", 3);
        const first: Array<{ file: FileRecord; task: Task }> = [];
        for (let i = 0; i < 6; i++)
          first.push(await add("write", "preparing", 20 + i));
        const retry = await add("write", "blocked", 40, { attempts: 2 });
        const tieLate = await add("write", "ready", 50, { created: 20 });
        const tieA = await add("write", "ready", 50, { created: 10 });
        const tieB = await add("write", "ready", 50, { created: 10 });
        await add("write", "preparing", 0, { attempts: 1 });
        await add("write", "failed", 0);
        await add("write", "ready", 0, { replicaStatus: "deleted" });
        await add("write", "ready", 101);
        const a1 = await add("action", "ready", 5);
        const a2 = await add("action", "ready", 6);
        await add("action", "blocked", 0);
        const d1 = await add("delete", "deleting", 7);
        const d2 = await add("delete", "ready", 8);
        await add("delete", "deleted", 0);
        const options = {
          kind: "write" as Task["kind"],
          limit: 100,
          excludedFiles: [] as string[],
          excludedTasks: [] as string[],
          activeWriteFiles: [
            admitted.file.id,
            admitted.file.id,
            a1.file.id,
            d1.file.id,
          ],
        };
        const expected = [
          ...first.map((x) => x.task.id),
          admitted.task.id,
          old.task.id,
          publishedCopy.task.id,
          retry.task.id,
          ...[tieA.task.id, tieB.task.id].sort(),
          tieLate.task.id,
        ];
        expect(
          (await f.db.read((r) => r.dueTasks(100, options))).map((t) => t.id),
        ).toEqual(expected);
        // Repeated single admissions never introduce a fourth-turn fairness exception.
        const excludedTasks: string[] = [];
        for (const id of expected) {
          const [next] = await f.db.read((r) =>
            r.dueTasks(100, { ...options, limit: 1, excludedTasks }),
          );
          expect(next!.id).toBe(id);
          excludedTasks.push(id);
        }
        const promoted = await f.db.read((r) =>
          r.dueTasks(100, {
            ...options,
            activeWriteFiles: [...options.activeWriteFiles, first[0]!.file.id],
            limit: 1,
          }),
        );
        expect(promoted[0]!.id).toBe(first[1]!.task.id);
        // Active IDs affect only writes, not FIFO selection in the other queues.
        for (const [kind, ids] of [
          ["action", [a1.task.id, a2.task.id]],
          ["delete", [d1.task.id, d2.task.id]],
        ] as const)
          expect(
            (await f.db.read((r) => r.dueTasks(100, { ...options, kind }))).map(
              (t) => t.id,
            ),
          ).toEqual([...ids]);
        expect(
          (
            await f.db.read((r) =>
              r.dueTasks(100, {
                ...options,
                excludedFiles: [first[0]!.file.id],
                excludedTasks: [first[1]!.task.id],
                limit: 1,
              }),
            )
          )[0]!.id,
        ).toBe(first[2]!.task.id);
      } finally {
        await f.close();
      }
    });
    test("successful upload counters preserve concurrent increments, rollback, date isolation and cleanup", async () => {
      const f = await open();
      try {
        await Promise.all(
          Array.from({ length: 2 }, () =>
            f.db.transaction((r) =>
              r.recordSuccessfulUpload("g:203.0.113.1", "2026-10-17"),
            ),
          ),
        );
        expect(
          await f.db.read((r) =>
            r.dailyUploadCount("g:203.0.113.1", "2026-10-17"),
          ),
        ).toBe(2);
        await expect(
          f.db.transaction(async (r) => {
            await r.recordSuccessfulUpload("u:test", "2026-10-17");
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        expect(
          await f.db.read((r) => r.dailyUploadCount("u:test", "2026-10-17")),
        ).toBe(0);
        await f.db.transaction((r) =>
          r.recordSuccessfulUpload("g:203.0.113.1", "2026-10-18"),
        );
        expect(
          await f.db.read((r) =>
            r.dailyUploadCount("g:203.0.113.1", "2026-10-18"),
          ),
        ).toBe(1);
        await f.db.transaction((r) => r.clearDailyUploads("2026-10-18"));
        expect(
          await f.db.read((r) =>
            r.dailyUploadCount("g:203.0.113.1", "2026-10-17"),
          ),
        ).toBe(0);
      } finally {
        await f.close();
      }
    });
    test("safe integer boundaries and aggregate overflow match", async () => {
      const f = await open();
      try {
        const valid = { ...user(), created_at: Number.MAX_SAFE_INTEGER };
        await f.db.transaction((r) => r.insertUser(valid));
        expect((await f.db.read((r) => r.user(valid.id)))?.created_at).toBe(
          Number.MAX_SAFE_INTEGER,
        );
        await expect(
          f.db.transaction((r) =>
            r.insertUser({
              ...user(),
              created_at: Number.MAX_SAFE_INTEGER + 1,
            }),
          ),
        ).rejects.toThrow("safe range");
        for (let i = 0; i < 2; i++) {
          const file: FileRecord = {
            ...entity(),
            guest_ip: null,
            owner_id: null,
            origin_kind: "upload",
            origin_user_id: null,
            upload_profile_id: null,
            storage_group_id: null,
            public_prefix: "/i/",
            logical_key: `large-${i}.png`,
            storage_key: `large-${i}.png`,
            mime_type: "image/png",
            byte_size: Number.MAX_SAFE_INTEGER,
            width: null,
            height: null,
            status: "ready",
            temp_path: null,
            temp_status: "cleaned",
            last_error: null,
            processing_results_json: null,
          };
          await f.db.transaction((r) => r.insertFile(file));
        }
        await expect(f.db.read((r) => r.systemSummary())).rejects.toThrow(
          "safe range",
        );
      } finally {
        await f.close();
      }
    });
    test("upload sessions preserve JSON and upload key identity, enforce unique file IDs and roll back", async () => {
      const f = await open();
      try {
        const upload = {
          ...entity(),
          upload_key_hash: "ab".repeat(32),
          guest_ip: null,
          owner_id: null,
          source_token_id: null,
          profile_id: crypto.randomUUID(),
          source_name: "",
          params_json: { quality: 80, enabled: false },
          organization_json: { tagIds: [], collectionIds: [] },
          byte_size: 101,
          part_size: 100,
          status: "pending" as const,
          file_id: crypto.randomUUID(),
          expires_at: Date.now() + 10000,
        };
        await f.db.transaction((r) => r.insertUploadSession(upload));
        await expect(
          f.db.transaction((r) =>
            r.insertUploadSession({
              ...upload,
              id: null as unknown as string,
              file_id: crypto.randomUUID(),
            }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        expect(await f.db.read((r) => r.uploadSession(upload.id))).toEqual(
          upload,
        );
        await expect(
          f.db.transaction((r) =>
            r.insertUploadSession({ ...upload, id: crypto.randomUUID() }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await expect(
          f.db.transaction(async (r) => {
            await r.saveUploadSession({ ...upload, status: "completing" });
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        expect((await f.db.read((r) => r.uploadSessions()))[0]!.status).toBe(
          "pending",
        );
        await f.db.transaction((r) => r.deleteUploadSession(upload.id));
        expect(await f.db.read((r) => r.uploadSession(upload.id))).toBeNull();
      } finally {
        await f.close();
      }
    });
    test("system summary counts ready files once and returns bounded ordered task failures", async () => {
      const f = await open();
      try {
        const empty = await f.db.read((r) => r.systemSummary());
        expect(empty).toEqual({
          readyFiles: 0,
          originalBytes: 0,
          pendingTasks: 0,
          runningTasks: 0,
          failedTasks: 0,
          failures: [],
        });
        const owner = user();
        const pipeline = {
          ...entity(),
          name: "Post-save",
          kind: "post_save" as const,
          config_version: 1,
        };
        await f.db.transaction(async (r) => {
          await r.insertUser(owner);
          await r.insertPipeline(pipeline);
          for (let i = 0; i < 14; i++) {
            const file: FileRecord = {
              ...entity(),
              guest_ip: null,
              owner_id: owner.id,
              origin_kind: "upload",
              origin_user_id: owner.id,
              upload_profile_id: null,
              storage_group_id: null,
              public_prefix: "/i/",
              logical_key: `${i}.png`,
              storage_key: `${i}.png`,
              mime_type: "image/png",
              byte_size: i === 0 ? 20 : i === 1 ? null : 1000,
              width: null,
              height: null,
              status: i < 2 ? "ready" : "failed",
              temp_path: null,
              temp_status: "cleaned",
              last_error: null,
              processing_results_json: null,
            };
            await r.insertFile(file);
            await r.insertTask({
              ...entity(),
              updated_at: i,
              kind: "action",
              file_id: file.id,
              replica_id: null,
              pipeline_id: pipeline.id,
              status: i === 0 ? "pending" : i === 1 ? "running" : "failed",
              attempts: 1,
              next_run_at: i === 0 ? Date.now() : null,
              last_error: i >= 2 ? "PLUGIN_SERVICE" : null,
            });
          }
        });
        const summary = await f.db.read((r) => r.systemSummary());
        expect(summary.readyFiles).toBe(2);
        expect(summary.originalBytes).toBe(20);
        expect(summary.pendingTasks).toBe(1);
        expect(summary.runningTasks).toBe(1);
        expect(summary.failedTasks).toBe(12);
        expect(summary.failures).toHaveLength(10);
        expect(summary.failures.map((f) => f.updatedAt)).toEqual([
          13, 12, 11, 10, 9, 8, 7, 6, 5, 4,
        ]);
      } finally {
        await f.close();
      }
    });
    test("group members and pipeline replacements are atomic; versions and task status prevent stale writes", async () => {
      const f = await open();
      try {
        const storage = {
            ...instance(),
            kind: "storage" as const,
            stage: null,
          },
          processor = instance(),
          secondProcessor = instance(),
          owner = user();
        const group = {
          ...entity(),
          name: "group",
          selection_strategy: "priority" as const,
          replica_count: 1,
          config_version: 1,
        };
        const file: FileRecord = {
          ...entity(),
          guest_ip: null,
          owner_id: owner.id,
          origin_kind: "upload",
          origin_user_id: owner.id,
          upload_profile_id: null,
          storage_group_id: null,
          public_prefix: "/i/",
          logical_key: "file.png",
          storage_key: "file.png",
          mime_type: "image/png",
          byte_size: 1,
          width: null,
          height: null,
          status: "ready",
          temp_path: "source",
          temp_status: "available",
          last_error: null,
          processing_results_json: null,
        };
        const replica = {
          ...entity(),
          file_id: file.id,
          storage_instance_id: storage.id,

          status: "pending" as const,
          locator_json: null,
        };
        const task = {
          ...entity(),
          kind: "write" as const,
          file_id: file.id,
          replica_id: replica.id,
          pipeline_id: null,
          status: "pending" as const,
          attempts: 0,
          next_run_at: Date.now(),
          last_error: null,
        };
        await f.db.transaction(async (r) => {
          await r.insertUser(owner);
          await r.saveInstance(storage);
          await r.saveInstance(processor);
          await r.saveInstance(secondProcessor);
          await r.insertGroup(group);
          await r.replaceMembers(group.id, [
            { instanceId: storage.id, weight: 1.5 },
          ]);
          await r.insertFile(file);
          await r.insertReplica(replica);
          await r.insertTask(task);
        });
        const cleanupJob = {
          ...entity(),
          source_id: storage.id,
          mode: "detach" as const,
          include_last: true,
          status: "active" as const,
        };
        const cleanupItem = {
          ...entity(),
          job_id: cleanupJob.id,
          file_id: file.id,
          replica_id: replica.id,
          status: "failed" as const,
          whole_file: false,
          error: "BUSY",
        };
        await f.db.transaction(async (r) => {
          await r.insertCleanupJob(cleanupJob);
          await r.insertCleanupItem(cleanupItem);
        });
        expect(await f.db.read((r) => r.cleanupPreview(storage.id))).toEqual({
          total: 1,
          withoutOtherReady: 1,
        });
        expect(
          await f.db.read((r) => r.cleanupJob(cleanupJob.id)),
        ).toMatchObject({ include_last: true, mode: "detach" });
        expect(
          (await f.db.read((r) => r.cleanupItems(cleanupJob.id, 1, 0)))[0],
        ).toMatchObject({ whole_file: false, error: "BUSY" });
        await expect(
          f.db.transaction((r) =>
            r.insertCleanupJob({ ...cleanupJob, ...entity() }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await expect(
          f.db.transaction((r) =>
            r.insertCleanupItem({ ...cleanupItem, ...entity() }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await f.db.transaction((r) => r.retryCleanupItems(cleanupJob.id));
        expect(
          (await f.db.read((r) => r.cleanupCounts(cleanupJob.id))).pending,
        ).toBe(1);
        expect(
          await f.db.read((r) => r.cleanupItems(cleanupJob.id, 1, 1)),
        ).toHaveLength(0);
        await f.db.transaction(async (r) => {
          await r.saveCleanupItem({
            ...cleanupItem,
            status: "success",
            error: null,
          });
          await r.saveCleanupJob({ ...cleanupJob, status: "finished" });
        });
        expect(await f.db.read((r) => r.activeCleanups())).toHaveLength(0);
        const newerFinished = {
          ...cleanupJob,
          ...entity(),
          created_at: cleanupJob.created_at + 1,
          status: "finished" as const,
        };
        await f.db.transaction(async (r) => {
          await r.insertCleanupJob(newerFinished);
          await r.saveCleanupJob(cleanupJob);
        });
        expect((await f.db.read((r) => r.latestCleanup(storage.id)))!.id).toBe(
          cleanupJob.id,
        );
        await f.db.transaction((r) =>
          r.saveCleanupJob({ ...cleanupJob, status: "finished" }),
        );
        const mismatch = {
          ...file,
          ...entity(),
          logical_key: "mismatched-cleanup.png",
        };
        await f.db.transaction((r) => r.insertFile(mismatch));
        await expect(
          f.db.transaction((r) =>
            r.insertCleanupItem({
              ...cleanupItem,
              ...entity(),
              job_id: newerFinished.id,
              file_id: mismatch.id,
            }),
          ),
        ).rejects.toBeInstanceOf(Conflict);

        await f.db.transaction((r) =>
          r.fillFileMetadata(file.id, {
            mime_type: "image/webp",
            byte_size: 999,
            width: 40,
            height: 20,
          }),
        );
        expect(await f.db.read((r) => r.file(file.id))).toMatchObject({
          mime_type: "image/png",
          byte_size: 1,
          width: 40,
          height: 20,
        });
        await f.db.transaction((r) =>
          r.saveFile({ ...file, status: "deleting" }, "ready"),
        );
        await f.db.transaction((r) =>
          r.fillFileMetadata(file.id, {
            mime_type: "image/webp",
            byte_size: 999,
            width: 40,
            height: 20,
          }),
        );
        expect(await f.db.read((r) => r.file(file.id))).toMatchObject({
          status: "deleting",
          width: null,
          height: null,
        });
        await f.db.transaction((r) => r.saveFile(file, "deleting"));

        expect(
          await f.db.read((r) =>
            r.objectRegistered(storage.id, file.logical_key, null),
          ),
        ).toBe(true);
        expect(
          await f.db.read((r) =>
            r.objectRegistered(storage.id, "other.png", null),
          ),
        ).toBe(false);
        await f.db.transaction((r) =>
          r.saveReplica({
            ...replica,
            locator_json: { key: "object", bucket: "test" },
          }),
        );
        expect(
          await f.db.read((r) =>
            r.objectRegistered(storage.id, "other.png", {
              bucket: "test",
              key: "object",
            }),
          ),
        ).toBe(true);
        expect(
          await f.db.read((r) =>
            r.objectRegistered(storage.id, file.logical_key, null),
          ),
        ).toBe(false);
        await f.db.transaction((r) => r.saveReplica(replica));
        await expect(
          f.db.transaction(async (r) => {
            await r.saveGroup(
              { ...group, name: "rollback", config_version: 2 },
              1,
            );
            await r.replaceMembers(group.id, [
              { instanceId: "missing", weight: 1 },
            ]);
          }),
        ).rejects.toThrow();
        expect((await f.db.read((r) => r.group(group.id)))?.name).toBe("group");
        expect(
          (await f.db.read((r) => r.members(group.id)))[0]?.storage_instance_id,
        ).toBe(storage.id);
        expect((await f.db.read((r) => r.members(group.id)))[0]?.weight).toBe(
          1.5,
        );
        await expect(
          f.db.transaction((r) =>
            r.replaceMembers(group.id, [{ instanceId: storage.id, weight: 0 }]),
          ),
        ).rejects.toThrow();
        expect((await f.db.read((r) => r.members(group.id)))[0]?.weight).toBe(
          1.5,
        );
        await f.db.transaction((r) =>
          r.saveGroup({ ...group, config_version: 2 }, 1),
        );
        await expect(
          f.db.transaction((r) =>
            r.saveGroup({ ...group, config_version: 2 }, 1),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await f.db.transaction((r) =>
          r.insertPipeline({
            ...entity(),
            id: "access",
            name: "Access",
            kind: "access",
            config_version: 1,
          }),
        );
        await expect(
          f.db.transaction((r) =>
            r.insertPipeline({
              ...entity(),
              name: "Duplicate access",
              kind: "access",
              config_version: 1,
            }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        const pipeline = (await f.db.read((r) => r.pipeline("access")))!;
        await f.db.transaction((r) =>
          r.savePipeline({ ...pipeline, config_version: 2 }, 1),
        );
        await expect(
          f.db.transaction((r) =>
            r.savePipeline({ ...pipeline, config_version: 2 }, 1),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await f.db.transaction((r) =>
          r.replaceSteps("access", [
            {
              ...entity(),
              enabled_params: [],
              pipeline_id: "access",
              position: 0,
              plugin_instance_id: processor.id,
              on_not_applicable: "abort",
            },
            {
              ...entity(),
              enabled_params: [],
              pipeline_id: "access",
              position: 1,
              plugin_instance_id: secondProcessor.id,
              on_not_applicable: "skip",
            },
          ]),
        );
        await expect(
          f.db.transaction((r) =>
            r.replaceSteps("access", [
              {
                ...entity(),
                enabled_params: [],
                pipeline_id: "access",
                position: 0,
                plugin_instance_id: storage.id,
                on_not_applicable: "abort",
              },
            ]),
          ),
        ).rejects.toThrow();
        expect(
          (await f.db.read((r) => r.steps("access"))).map(
            (s) => s.plugin_instance_id,
          ),
        ).toEqual([processor.id, secondProcessor.id]);
        await f.db.transaction((r) =>
          r.saveTask({ ...task, status: "running", attempts: 1 }, "pending"),
        );
        await expect(
          f.db.transaction((r) =>
            r.saveTask({ ...task, status: "running" }, "pending"),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        // Capacity uses the same accounting for every managed replica state.
        for (const status of [
          "pending",
          "writing",
          "ready",
          "write_failed",
          "delete_pending",
          "deleting",
          "delete_failed",
        ] as const) {
          await f.db.transaction((r) => r.saveReplica({ ...replica, status }));
          expect(await f.db.read((r) => r.storageUsedBytes(storage.id))).toBe(
            1,
          );
          expect(
            (await f.db.read((r) => r.storageUsage([storage.id]))).get(
              storage.id,
            ),
          ).toBe(1);
          expect(
            await f.db.read((r) => r.instanceReplicaCount(storage.id)),
          ).toBe(1);
        }
        await f.db.transaction(async (r) => {
          await r.saveTask({ ...task, status: "failed", next_run_at: null });
          await r.saveReplica({ ...replica, status: "deleted" });
          await r.replaceMembers(group.id, []);
          await r.deleteInstance(storage.id);
        });
        expect(await f.db.read((r) => r.instance(storage.id))).toBeNull();
        expect(await f.db.read((r) => r.replica(replica.id))).toMatchObject({
          storage_instance_id: storage.id,
          status: "deleted",
        });
        expect(await f.db.read((r) => r.task(task.id))).toMatchObject({
          status: "failed",
        });
        expect(await f.db.read((r) => r.file(file.id))).toMatchObject({
          id: file.id,
        });
        expect(await f.db.read((r) => r.instanceReplicaCount(storage.id))).toBe(
          0,
        );
        expect(
          (await f.db.read((r) => r.storageUsage([storage.id]))).get(
            storage.id,
          ),
        ).toBeUndefined();
        await expect(
          f.db.transaction((r) => r.saveReplica(replica)),
        ).rejects.toBeInstanceOf(Conflict);
        await expect(
          f.db.transaction((r) => r.insertReplica({ ...replica, ...entity() })),
        ).rejects.toThrow("Expected storage instance");
      } finally {
        await f.close();
      }
    });
    test("cleanup candidates include failures once and retain destructive-cleanup priority", async () => {
      const f = await open();
      try {
        const files: FileRecord[] = [];
        for (const status of [
          "preparing",
          "ready",
          "blocked",
          "failed",
          "deleting",
          "deleted",
        ] as const) {
          for (const temp_status of [
            "cleaned",
            "available",
            "missing",
          ] as const) {
            const key = `${status}-${temp_status}.png`;
            files.push({
              ...entity(),
              owner_id: null,
              origin_kind: "upload",
              origin_user_id: null,
              guest_ip: null,
              upload_profile_id: null,
              storage_group_id: null,
              public_prefix: "/i/",
              logical_key: key,
              storage_key: key,
              mime_type: "image/png",
              byte_size: 1,
              width: 1,
              height: 1,
              status,
              temp_status,
              temp_path: temp_status === "cleaned" ? null : key,
              last_error: null,
              processing_results_json: null,
            });
          }
        }
        await f.db.transaction(async (r) => {
          for (const file of files) await r.insertFile(file);
        });
        const candidates = await f.db.read((r) => r.filesNeedingCleanup());
        const expected = files.filter(
          (file) =>
            ["failed", "deleting", "deleted"].includes(file.status) ||
            (["ready", "blocked"].includes(file.status) &&
              file.temp_path !== null),
        );
        expect(candidates.map((file) => file.id).sort()).toEqual(
          expected.map((file) => file.id).sort(),
        );
        expect(
          candidates
            .slice(0, 6)
            .every((file) => ["failed", "deleting"].includes(file.status)),
        ).toBe(true);
        expect(
          candidates
            .slice(6)
            .every((file) =>
              ["ready", "blocked", "deleted"].includes(file.status),
            ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    });
    test("file filters and counts agree, preserve nulls and order ties by ID", async () => {
      const f = await open();
      try {
        const owner = user();
        const base: FileRecord = {
          ...entity(),
          guest_ip: null,
          owner_id: owner.id,
          origin_kind: "upload",
          origin_user_id: owner.id,
          upload_profile_id: null,
          storage_group_id: null,
          public_prefix: "/i/",
          logical_key: "中文 %.png",
          storage_key: "中文 %.png",
          mime_type: "image/png",
          byte_size: null,
          width: null,
          height: null,
          status: "ready",
          temp_path: null,
          temp_status: "cleaned",
          last_error: null,
          processing_results_json: null,
        };
        const second = {
          ...base,
          id: crypto.randomUUID(),
          logical_key: "other.png",
          storage_key: "other.png",
        };
        await f.db.transaction(async (r) => {
          await r.insertUser(owner);
          await r.insertFile(base);
          await r.insertFile(second);
          await r.insertFile({
            ...base,
            id: crypto.randomUUID(),
            logical_key: "failed.svg",
            storage_key: "failed.svg",
            mime_type: "image/svg+xml",
            status: "failed",
          });
        });
        await f.db.read(async (r) => {
          const filter = { status: "ready" as const, mimeType: "image/png" };
          expect(await r.countFiles(filter)).toBe(2);
          const dated = {
            ...filter,
            createdFrom: base.created_at,
            createdBefore: base.created_at + 1,
          };
          expect(await r.countFiles(dated)).toBe(2);
          expect((await r.files(30, 0, dated)).length).toBe(2);
          expect(
            await r.countFiles({ ...filter, createdBefore: base.created_at }),
          ).toBe(0);
          expect(
            (
              await r.files(30, 0, {
                ...filter,
                createdFrom: base.created_at + 1,
              })
            ).length,
          ).toBe(0);
          expect((await r.files(10, 0, filter)).map((x) => x.id)).toEqual(
            [base.id, second.id].sort().reverse(),
          );
          expect((await r.files(1, 1, filter)).length).toBe(1);
          const all = await r.files(30, 0);
          expect(all.map((file) => file.id)).toEqual(
            all
              .map((file) => file.id)
              .sort()
              .reverse(),
          );
          expect((await r.files(1, 1)).map((file) => file.id)).toEqual([
            all[1]!.id,
          ]);
          expect(await r.countFiles({ q: "%" })).toBe(1);
          expect((await r.files(1, 0, { q: "%" }))[0]?.byte_size).toBeNull();
          expect(await r.countFiles({ status: "deleted" })).toBe(0);
        });
      } finally {
        await f.close();
      }
    });
    test("transactions roll back and expired transaction contexts cannot escape", async () => {
      const f = await open();
      try {
        let escaped: Repositories | undefined;
        await expect(
          f.db.transaction(async (r) => {
            escaped = r;
            await r.insertUser(user());
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        expect(await f.db.read((r) => r.userCount())).toBe(0);
        await expect(escaped!.userCount()).rejects.toThrow("expired");
      } finally {
        await f.close();
      }
    });
    test("concurrent reads cannot observe uncommitted writes", async () => {
      const f = await open();
      try {
        let resume!: () => void, entered!: () => void;
        const gate = new Promise<void>((r) => (resume = r));
        const started = new Promise<void>((r) => (entered = r));
        const writer = f.db.transaction(async (r) => {
          await r.insertUser(user());
          entered();
          await gate;
          throw new Error("rollback");
        });
        const settled = writer.catch(() => {});
        await started;
        const reader = f.db.read(async (r) => {
          return r.userCount();
        });
        await new Promise((r) => setTimeout(r, 10));
        resume();
        await settled;
        expect(await reader).toBe(0);
      } finally {
        await f.close();
      }
    });
    test("uniqueness and foreign keys use domain conflicts", async () => {
      const f = await open();
      try {
        const a = user();
        await f.db.transaction((r) => r.insertUser(a));
        await expect(
          f.db.transaction((r) =>
            r.insertUser({ ...a, id: crypto.randomUUID() }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await expect(
          f.db.transaction((r) =>
            r.insertCredential("session", {
              ...entity(),
              user_id: "missing",
              auth_version: 1,
              token_hash: "hash",
              expires_at: Date.now(),
              revoked_at: null,
            }),
          ),
        ).rejects.toBeInstanceOf(Conflict);
      } finally {
        await f.close();
      }
    });
    test("configuration versions reject stale writes; JSON and null preserve types", async () => {
      const f = await open();
      try {
        const value = instance();
        await f.db.transaction((r) => r.saveInstance(value));
        const fetched = await f.db.read((r) => r.instance(value.id));
        expect(fetched?.config_json).toEqual(value.config_json);
        await f.db.transaction((r) =>
          r.saveInstance({ ...value, config_version: 2 }, 1),
        );
        await expect(
          f.db.transaction((r) =>
            r.saveInstance({ ...value, config_version: 2 }, 1),
          ),
        ).rejects.toBeInstanceOf(Conflict);
        await f.db.transaction((r) => r.updateState(value.id, { n: 1 }, 1));
        await expect(
          f.db.transaction((r) => r.updateState(value.id, { n: 2 }, 1)),
        ).rejects.toBeInstanceOf(Conflict);
      } finally {
        await f.close();
      }
    });
    test("user roles, profile grants and guest flags remain typed and transactional", async () => {
      const f = await open();
      try {
        const owner = user(),
          path = { ...instance(), kind: "path" as const, stage: null };
        const group = {
          ...entity(),
          name: "group",
          selection_strategy: "priority" as const,
          replica_count: 1,
          config_version: 1,
        };
        const profile = {
          ...entity(),
          name: "public",
          public_prefix: "/i/",
          path_instance_id: path.id,
          storage_group_id: group.id,
          upload_pipeline_id: null,
          post_save_pipeline_id: null,
          enabled: true,
          allow_guest_upload: true,
          config_version: 1,
          max_upload_bytes: 1024,
          allowed_mime_types: ["image/png"],
        };
        await f.db.transaction(async (r) => {
          await r.insertUser(owner);
          await r.saveInstance(path);
          await r.insertGroup(group);
          await r.insertProfile(profile);
          await r.replaceUserProfiles(owner.id, [profile.id]);
        });
        expect(
          (await f.db.read((r) => r.profile(profile.id)))!.allow_guest_upload,
        ).toBe(true);
        await expect(
          f.db.transaction(async (r) => {
            await r.updateUser(owner.id, "member", "disabled");
            await r.replaceUserProfiles(owner.id, []);
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        expect((await f.db.read((r) => r.user(owner.id)))?.role).toBe("admin");
        expect(await f.db.read((r) => r.userProfiles(owner.id))).toEqual([
          profile.id,
        ]);
        await expect(
          f.db.transaction((r) => r.replaceUserProfiles(owner.id, ["missing"])),
        ).rejects.toBeInstanceOf(Conflict);
        expect(await f.db.read((r) => r.userProfiles(owner.id))).toEqual([
          profile.id,
        ]);
        await f.db.transaction((r) => r.deleteProfile(profile.id));
        expect(await f.db.read((r) => r.userProfiles(owner.id))).toEqual([]);
      } finally {
        await f.close();
      }
    });
    test("password version changes cannot overwrite a concurrent change", async () => {
      const f = await open();
      try {
        const value = user();
        await f.db.transaction((r) => r.insertUser(value));
        await f.db.transaction((r) => r.changePassword(value.id, 1, "next"));
        await expect(
          f.db.transaction((r) => r.changePassword(value.id, 1, "stale")),
        ).rejects.toBeInstanceOf(Conflict);
        expect((await f.db.read((r) => r.user(value.id)))?.auth_version).toBe(
          2,
        );
      } finally {
        await f.close();
      }
    });
  });
}
function user(): User {
  return {
    ...entity(),
    default_upload_profile_id: null,
    username: "admin",
    password_hash: "test",
    role: "admin",
    status: "active",
    max_upload_bytes: null,
    daily_upload_limit: null,
    auth_version: 1,
  };
}
export function instance(): Instance {
  return {
    ...entity(),
    plugin_id: "test",
    plugin_version: "1",
    kind: "processor",
    stage: "access",
    name: "test",
    config_json: { flag: true, items: ["a", null, 3], nested: { value: "x" } },
    config_version: 1,
    config_schema_version: 1,
    secrets_encrypted: null,
    secrets_version: 1,
    state_json: {},
    state_version: 1,
    last_init_error: null,
  };
}
