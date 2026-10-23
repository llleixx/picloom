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
    f.app.config.taskConcurrency = 2;
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
    f.app.config.taskConcurrency = 2;
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
    f.app.config.taskConcurrency = 1;
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
