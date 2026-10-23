import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { entity, type FileRecord, type Replica } from "../src/persistence/port";

function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for task progress");
    await Bun.sleep(1);
  }
}
async function upload(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await (await f.upload()).json();
  await f.app.files.tasks.drain();
  const file = (await f.app.db.read((r) => r.file(result.id)))!;
  const replica = (await f.app.db.read((r) => r.replicas(result.id)))[0]!;
  return { file, replica };
}
async function queueDelete(
  f: Awaited<ReturnType<typeof fixture>>,
  file: FileRecord,
  replica: Replica,
) {
  await f.app.db.transaction(async (r) => {
    file.status = "deleting";
    await r.saveFile(file, "ready");
    replica.status = "delete_pending";
    await r.saveReplica(replica);
    await r.insertTask({
      ...entity(),
      kind: "delete",
      file_id: file.id,
      replica_id: replica.id,
      pipeline_id: null,
      status: "pending",
      attempts: 0,
      next_run_at: Date.now(),
      last_error: null,
    });
  });
}

test("dispatch fills idle slots beside a slow task, enforces capacity and drains on close", async () => {
  const f = await fixture();
  const slow = gate(),
    fast = gate(),
    next = gate();
  let deletion: ReturnType<typeof spyOn> | undefined;
  let lease: ReturnType<typeof f.app.plugins.acquire<"storage">> | undefined;
  try {
    f.app.config.deleteConcurrency = 2;
    const a = await upload(f),
      b = await upload(f),
      c = await upload(f),
      queued = await upload(f);
    lease = f.app.plugins.acquire(a.replica.storage_instance_id, "storage");
    const entered = new Set<string>();
    let active = 0,
      peak = 0;
    let slowSignal: AbortSignal | undefined;
    deletion = spyOn(lease.runtime, "delete").mockImplementation(
      async (input, ctx) => {
        entered.add(input.storageKey);
        active++;
        peak = Math.max(peak, active);
        try {
          if (input.storageKey === a.file.storage_key) {
            slowSignal = ctx.signal;
            await slow.promise;
          }
          if (input.storageKey === b.file.storage_key) await fast.promise;
          if (
            input.storageKey !== a.file.storage_key &&
            input.storageKey !== b.file.storage_key
          )
            await next.promise;
        } finally {
          active--;
        }
      },
    );
    await queueDelete(f, a.file, a.replica);
    await queueDelete(f, b.file, b.replica);
    await Promise.all([
      f.app.files.tasks.dispatch(),
      f.app.files.tasks.dispatch(),
    ]);
    await until(() => entered.size === 2);
    await queueDelete(f, c.file, c.replica);
    expect(await f.app.files.tasks.dispatch()).toEqual([]);
    fast.release();
    await until(async () =>
      (await f.app.db.read((r) => r.tasks(b.file.id))).every(
        (t) => t.status === "success",
      ),
    );
    await until(() => entered.has(c.file.storage_key));
    expect(peak).toBe(2);
    // Cleanup must skip the active file, rather than changing its replica/task state.
    await f.app.files.tasks.cleanupPending();
    expect((await f.app.db.read((r) => r.replica(a.replica.id)))!.status).toBe(
      "deleting",
    );
    await queueDelete(f, queued.file, queued.replica);
    let closed = false;
    const closing = f.app.files.tasks.close().then(() => {
      closed = true;
    });
    await until(() => slowSignal!.aborted);
    expect(closed).toBe(false);
    expect(await f.app.files.tasks.dispatch()).toEqual([]);
    slow.release();
    next.release();
    await closing;
    expect(closed).toBe(true);
    expect(
      (await f.app.db.read((r) => r.tasks(queued.file.id))).find(
        (t) => t.kind === "delete",
      )!.attempts,
    ).toBe(0);
  } finally {
    slow.release();
    fast.release();
    next.release();
    await f.app.files.tasks.drain();
    deletion?.mockRestore();
    await lease?.release();
    await f.close();
  }
});

test("failed-write cleanup runs as a bounded deletion while unrelated tasks continue", async () => {
  const f = await fixture();
  const blocked = gate();
  let recovery: ReturnType<typeof spyOn> | undefined,
    deletion: ReturnType<typeof spyOn> | undefined;
  let lease: ReturnType<typeof f.app.plugins.acquire<"storage">> | undefined;
  let recoveryLease:
    | ReturnType<typeof f.app.plugins.acquire<"storage">>
    | undefined;
  let cleaning: Promise<void> | undefined;
  try {
    f.app.config.deleteConcurrency = 2;
    const a = await upload(f),
      b = await upload(f);
    await queueDelete(f, a.file, a.replica);
    await queueDelete(f, b.file, b.replica);
    const source = await (
      await f.request("/api/storage-sources", "POST", {
        pluginId: "builtin.local",
        version: "1.0.0",
        name: "Recovery source",
        config: { root: f.root + "/recovery-source" },
        secretEdits: {},
      })
    ).json();
    recoveryLease = f.app.plugins.acquire(source.id, "storage");
    const uncertain: Replica = {
      ...a.replica,
      ...entity(),
      storage_instance_id: source.id,

      status: "write_failed",
    };
    await f.app.db.transaction(async (r) => {
      await r.insertReplica(uncertain);
      await r.insertTask({
        ...entity(),
        kind: "write",
        file_id: a.file.id,
        replica_id: uncertain.id,
        pipeline_id: null,
        status: "failed",
        attempts: 1,
        next_run_at: null,
        last_error: "WRITE_FAILED",
      });
    });
    lease = f.app.plugins.acquire(a.replica.storage_instance_id, "storage");
    let recovering = false;
    recovery = spyOn(recoveryLease.runtime, "delete").mockImplementation(
      async () => {
        recovering = true;
        await blocked.promise;
        return;
      },
    );
    const deleted: string[] = [];
    deletion = spyOn(lease.runtime, "delete").mockImplementation(
      async (input) => {
        deleted.push(input.storageKey);
      },
    );
    await f.app.files.tasks.cleanupPending();
    expect(recovering).toBe(false); // Cleanup only schedules; it never makes remote calls.
    await f.app.db.transaction(async (r) => {
      for (const task of await r.tasks(a.file.id))
        await r.saveTask({
          ...task,
          next_run_at:
            task.replica_id === uncertain.id ? 0 : Date.now() + 60_000,
        });
    });
    await f.app.files.tasks.dispatch();
    await until(() => recovering && deleted.includes(b.file.storage_key));
    expect(
      (await f.app.db.read((r) => r.tasks(a.file.id))).find(
        (t) => t.replica_id === uncertain.id && t.kind === "delete",
      )?.status,
    ).toBe("running");
    blocked.release();
    await f.app.files.tasks.drain();
    await f.app.db.transaction(async (r) => {
      const task = (await r.tasks(a.file.id)).find(
        (t) => t.replica_id === a.replica.id && t.kind === "delete",
      )!;
      await r.saveTask({ ...task, next_run_at: Date.now() });
    });
    await f.app.files.sweep();
    expect(deleted).toEqual([b.file.storage_key, a.file.storage_key]);
    expect((await f.app.db.read((r) => r.file(a.file.id)))!.status).toBe(
      "deleted",
    );
  } finally {
    blocked.release();
    await cleaning;
    await f.app.files.tasks.drain();
    recovery?.mockRestore();
    deletion?.mockRestore();
    await lease?.release();
    await recoveryLease?.release();
    await f.close();
  }
});

test("one dispatch drains a fast backlog and skips tasks whose files no longer allow execution", async () => {
  const f = await fixture();
  try {
    f.app.config.deleteConcurrency = 1;
    const stale = await upload(f);
    await queueDelete(f, stale.file, stale.replica);
    const pending = (await f.app.db.read((r) => r.tasks(stale.file.id))).find(
      (t) => t.kind === "delete",
    )!;
    await f.app.db.transaction(async (r) => {
      pending.kind = "write";
      pending.next_run_at = 0;
      await r.saveTask(pending);
      stale.replica.status = "pending";
      await r.saveReplica(stale.replica);
    });
    const healthy = [];
    for (let i = 0; i < 4; i++) {
      const item = await upload(f);
      await queueDelete(f, item.file, item.replica);
      healthy.push(item);
    }
    await f.app.files.tasks.dispatch();
    await f.app.files.tasks.drain();
    for (const item of healthy)
      expect(
        (await f.app.db.read((r) => r.tasks(item.file.id))).find(
          (t) => t.kind === "delete",
        )!.status,
      ).toBe("success");
    expect((await f.app.db.read((r) => r.task(pending.id)))!.attempts).toBe(0);
  } finally {
    await f.close();
  }
});

test("pause fences an in-progress admission query and resume restarts the backlog", async () => {
  const f = await fixture();
  const queried = gate(),
    release = gate();
  const { SqlRepositories } = await import("../src/persistence/repositories");
  const item = await upload(f);
  await f.app.files.tasks.drain();
  await queueDelete(f, item.file, item.replica);
  const original = SqlRepositories.prototype.dueTasks;
  const query = spyOn(SqlRepositories.prototype, "dueTasks").mockImplementation(
    async function (this: InstanceType<typeof SqlRepositories>, ...args) {
      const result = await original.apply(this, args);
      queried.release();
      await release.promise;
      return result;
    },
  );
  try {
    const dispatch = f.app.files.tasks.dispatch();
    await queried.promise;
    const paused = f.app.files.tasks.pause();
    release.release();
    await Promise.all([dispatch, paused]);
    await f.app.files.tasks.drain();
    expect(
      (await f.app.db.read((r) => r.tasks(item.file.id))).find(
        (t) => t.kind === "delete",
      )!.attempts,
    ).toBe(0);
    expect(await f.app.files.tasks.dispatch()).toEqual([]);
    query.mockRestore();
    f.app.files.tasks.resume();
    await f.app.files.tasks.drain();
    expect(
      (await f.app.db.read((r) => r.tasks(item.file.id))).find(
        (t) => t.kind === "delete",
      )!.status,
    ).toBe("success");
  } finally {
    release.release();
    query.mockRestore();
    await f.close();
  }
});

test("write, post-save and delete queues have independent live limits and pause together", async () => {
  const f = await fixture();
  type Kind = "write" | "action" | "delete";
  const active = { write: 0, action: 0, delete: 0 };
  const peak = { write: 0, action: 0, delete: 0 };
  const entered: Record<
    Kind,
    Array<ReturnType<typeof gate> & { fileId: string }>
  > = {
    write: [],
    action: [],
    delete: [],
  };
  let finish = false;
  async function hold<T>(
    kind: Kind,
    fileId: string,
    operation: () => Promise<T>,
  ) {
    const barrier = gate();
    entered[kind].push({ ...barrier, fileId });
    peak[kind] = Math.max(peak[kind], ++active[kind]);
    try {
      if (!finish) await barrier.promise;
      return await operation();
    } finally {
      active[kind]--;
    }
  }
  const uploads: Promise<Response>[] = [];
  let write: ReturnType<typeof spyOn> | undefined;
  let deletion: ReturnType<typeof spyOn> | undefined;
  let lease: ReturnType<typeof f.app.plugins.acquire<"storage">> | undefined;
  try {
    const seeds: Array<Awaited<ReturnType<typeof upload>>> = [];
    for (let i = 0; i < 6; i++) seeds.push(await upload(f));
    await f.app.files.tasks.drain();
    f.app.plugins.register({
      id: "test.queue-action",
      version: "1",
      kind: "processor",
      apiVersion: 1,
      defaultLocale: "en-US",
      nameKey: "name",
      messages: { "en-US": { name: "Queue action" } },
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return {
              execute: async (input) =>
                hold("action", input.fileId, async () => ({
                  status: "pass" as const,
                })),
            };
          },
        },
      },
    });
    const pipeline = await f.app.configuration.savePipeline({
      name: "Queue action",
      kind: "post_save",
      steps: [{ pluginId: "test.queue-action", version: "1", config: {} }],
    });
    lease = f.app.plugins.acquire(
      seeds[0]!.replica.storage_instance_id,
      "storage",
    );
    const originalWrite = lease.runtime.write.bind(lease.runtime);
    const originalDelete = lease.runtime.delete.bind(lease.runtime);
    write = spyOn(lease.runtime, "write").mockImplementation((input, ctx) =>
      hold("write", input.fileId, () => originalWrite(input, ctx)),
    );
    deletion = spyOn(lease.runtime, "delete").mockImplementation((input, ctx) =>
      hold(
        "delete",
        seeds.find((seed) => seed.file.storage_key === input.storageKey)!.file
          .id,
        () => originalDelete(input, ctx),
      ),
    );
    await f.app.files.tasks.pause();
    f.app.config.uploadConcurrency = 6;
    for (let i = 0; i < 6; i++) uploads.push(f.upload());
    await until(
      async () =>
        (await f.app.db.read((r) => r.filesInStates(["preparing"]))).length ===
        6,
    );
    f.app.files.tasks.resume();
    await until(() => active.write === 4);
    // The two otherwise idle queues do not lend their slots to pending writes.
    expect(await f.app.files.tasks.dispatch()).toEqual([]);
    expect(entered.write).toHaveLength(4);
    for (const seed of seeds.slice(0, 3)) {
      await f.app.db.transaction((r) =>
        r.insertTask({
          ...entity(),
          kind: "action",
          file_id: seed.file.id,
          replica_id: null,
          pipeline_id: pipeline.id,
          status: "pending",
          attempts: 0,
          next_run_at: Date.now(),
          last_error: null,
        }),
      );
    }
    for (const seed of seeds.slice(3))
      await queueDelete(f, seed.file, seed.replica);
    await Promise.all([
      f.app.files.tasks.dispatch(),
      f.app.files.tasks.dispatch(),
    ]);
    await until(() => active.action === 2 && active.delete === 2);
    expect(active).toEqual({ write: 4, action: 2, delete: 2 });
    expect(peak).toEqual(active);
    // The settings callback must wake every newly available queue without a timer tick.
    await f.app.delivery.save({
      ...f.app.delivery.get(),
      writeConcurrency: 5,
      postSaveConcurrency: 3,
      deleteConcurrency: 3,
    });
    await until(
      () => active.write === 5 && active.action === 3 && active.delete === 3,
    );
    await f.app.delivery.save({
      ...f.app.delivery.get(),
      writeConcurrency: 1,
      postSaveConcurrency: 1,
      deleteConcurrency: 1,
    });
    expect(active).toEqual({ write: 5, action: 3, delete: 3 });
    entered.write[0]!.release();
    await until(
      async () =>
        (await f.app.db.read((r) => r.file(entered.write[0]!.fileId)))!
          .status === "ready",
    );
    await until(() => active.write === 4);
    await f.app.files.tasks.dispatch();
    expect(entered.write).toHaveLength(5);
    await f.app.files.tasks.pause();
    let drained = false;
    const draining = f.app.files.tasks.drain().then(() => {
      drained = true;
    });
    // Release each held operation after its commit, so this assertion measures
    // draining all queues rather than exhausting serializable retry budgets.
    for (let i = 1; i < entered.write.length; i++) {
      entered.write[i]!.release();
      await until(
        async () =>
          (await f.app.db.read((r) => r.file(entered.write[i]!.fileId)))!
            .status === "ready",
      );
    }
    await until(() => active.write === 0);
    expect(drained).toBe(false);
    for (let i = 0; i < entered.action.length; i++) {
      entered.action[i]!.release();
      await until(async () =>
        (await f.app.db.read((r) => r.tasks(entered.action[i]!.fileId))).some(
          (task) => task.kind === "action" && task.status === "success",
        ),
      );
    }
    await until(() => active.action === 0);
    expect(drained).toBe(false);
    for (let i = 0; i < entered.delete.length; i++) {
      entered.delete[i]!.release();
      await until(async () =>
        (await f.app.db.read((r) => r.tasks(entered.delete[i]!.fileId))).some(
          (task) => task.kind === "delete" && task.status === "success",
        ),
      );
    }
    await draining;
    expect(entered.write).toHaveLength(5);
    finish = true;
    f.app.files.tasks.resume();
    for (const response of await Promise.all(uploads))
      expect(response.status).toBe(201);
    await f.app.files.tasks.drain();
    expect(entered.write).toHaveLength(6);
    expect(peak).toEqual({ write: 5, action: 3, delete: 3 });
  } finally {
    finish = true;
    for (const barriers of Object.values(entered))
      for (const barrier of barriers) barrier.release();
    f.app.files.tasks.resume();
    await Promise.allSettled(uploads);
    await f.app.files.tasks.drain();
    write?.mockRestore();
    deletion?.mockRestore();
    await lease?.release();
    await f.close();
  }
});

test("a failed write claim does not stop deletion or immediately retry itself", async () => {
  const f = await fixture();
  const held = gate();
  let claim: ReturnType<typeof spyOn> | undefined;
  let deletion: ReturnType<typeof spyOn> | undefined;
  let lease: ReturnType<typeof f.app.plugins.acquire<"storage">> | undefined;
  try {
    const a = await upload(f),
      b = await upload(f);
    await f.app.files.tasks.pause();
    const task = (await f.app.db.read((r) => r.tasks(a.file.id)))[0]!;
    await f.app.db.transaction((r) =>
      r.saveTask({ ...task, status: "pending", next_run_at: 0 }),
    );
    await queueDelete(f, b.file, b.replica);
    const { SqlRepositories } = await import("../src/persistence/repositories");
    const original = SqlRepositories.prototype.saveTask;
    let claims = 0,
      deleting = false;
    claim = spyOn(SqlRepositories.prototype, "saveTask").mockImplementation(
      async function (
        this: InstanceType<typeof SqlRepositories>,
        value,
        expected,
      ) {
        if (value.id === task.id && value.status === "running") {
          claims++;
          throw new Error("Test persistence failure");
        }
        return original.call(this, value, expected);
      },
    );
    lease = f.app.plugins.acquire(b.replica.storage_instance_id, "storage");
    const originalDelete = lease.runtime.delete.bind(lease.runtime);
    deletion = spyOn(lease.runtime, "delete").mockImplementation(
      async (input, ctx) => {
        deleting = true;
        await held.promise;
        return originalDelete(input, ctx);
      },
    );
    f.app.files.tasks.resume();
    await until(() => deleting);
    expect(claims).toBe(1);
    const pending = await f.app.db.read((r) => r.task(task.id));
    expect(pending!.status).toBe("pending");
    expect(pending!.attempts).toBe(task.attempts);
    claim.mockRestore();
    held.release();
    await f.app.files.tasks.drain();
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "success",
    );
  } finally {
    claim?.mockRestore();
    held.release();
    f.app.files.tasks.resume();
    await f.app.files.tasks.drain();
    deletion?.mockRestore();
    await lease?.release();
    await f.close();
  }
});
