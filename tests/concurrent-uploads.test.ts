import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { PluginError } from "@picloom/plugin-sdk";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function copies() {
  const f = await fixture();
  const profile = await f.app.configuration.profile(f.profileId);
  const group = await f.app.configuration.group(profile.storageGroupId);
  const second = await (
    await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Second",
      config: { root: join(f.root, "second") },
    })
  ).json();
  await f.app.configuration.saveGroup(
    {
      ...group,
      replicaCount: 2,
      selectionStrategy: "priority",
      members: [...group.members, { instanceId: second.id, weight: 1 }],
      expectedVersion: group.configVersion,
    },
    group.id,
  );
  const leases = [group.members[0]!.instanceId, second.id as string].map((id) =>
    f.app.plugins.acquire(id, "storage"),
  );
  return {
    f,
    leases,
    async close() {
      await Promise.all(leases.map((lease) => lease.release()));
      await f.close();
    },
  };
}
function upload(f: Awaited<ReturnType<typeof fixture>>, signal: AbortSignal) {
  const form = new FormData();
  form.set("profileId", f.profileId);
  form.set("file", new File([new Uint8Array(f.png)], "image.png"));
  return handler(f.app)(
    new Request("http://localhost/api/files", {
      method: "POST",
      body: form,
      signal,
      headers: { cookie: f.cookie, "x-csrf-token": f.csrf },
    }),
  );
}

test("writes start concurrently; first success returns while the other write continues", async () => {
  const { f, leases, close } = await copies();
  const entered = [gate(), gate()],
    release = [gate(), gate()];
  const calls = [0, 0];
  const spies = leases.map((lease, index) => {
    const original = lease.runtime.write.bind(lease.runtime);
    return spyOn(lease.runtime, "write").mockImplementation(
      async (input, ctx) => {
        calls[index]!++;
        entered[index]!.release();
        await release[index]!.promise;
        return original(input, ctx);
      },
    );
  });
  const controller = new AbortController();
  try {
    const pending = upload(f, controller.signal);
    await Promise.all(entered.map((item) => item.promise));
    release[1]!.release();
    const response = await pending;
    expect(response.status).toBe(201);
    const image = await response.json();
    const file = (await f.app.db.read((r) => r.file(image.id)))!;
    expect(file.status).toBe("ready");
    expect(await Bun.file(join(f.root, "temp", file.temp_path!)).exists()).toBe(
      true,
    );
    const tasks = await f.app.db.read((r) => r.tasks(image.id));
    expect(tasks.map((task) => task.status).sort()).toEqual([
      "running",
      "success",
    ]);
    controller.abort();
    release[0]!.release();
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.replicas(image.id))).map((r) => r.status),
    ).toEqual(["ready", "ready"]);
    expect(calls).toEqual([1, 1]);
    expect((await f.app.db.read((r) => r.file(image.id)))!.temp_status).toBe(
      "cleaned",
    );
    const operations = await (
      await f.request(`/api/files/${image.id}/operations`)
    ).json();
    expect(operations.replicas.every((r: object) => !("role" in r))).toBe(true);
  } finally {
    release.forEach((item) => item.release());
    await f.app.files.tasks.drain();
    spies.forEach((spy) => spy.mockRestore());
    await close();
  }
});

test("all first attempts fail once without background retries or quota consumption", async () => {
  const { f, leases, close } = await copies();
  const spies = leases.map((lease) =>
    spyOn(lease.runtime, "write").mockImplementation(async () => {
      throw new PluginError("NETWORK", "offline", true);
    }),
  );
  try {
    expect((await f.upload()).status).toBe(502);
    await f.app.files.sweep();
    const [file] = await f.app.db.read((r) => r.files(10, 0));
    expect(file!.status).toBe("delete_failed");
    const tasks = await f.app.db.read((r) => r.tasks(file!.id));
    expect(
      tasks.filter((t) => t.kind === "write").map((t) => t.attempts),
    ).toEqual([1, 1]);
    expect(
      tasks
        .filter((t) => t.kind === "write")
        .every((t) => t.status === "cancelled"),
    ).toBe(true);
    expect(
      tasks.filter((t) => t.kind === "delete").map((t) => t.status),
    ).toEqual(["failed", "failed"]);
    expect(
      (await f.app.db.read((r) => r.replicas(file!.id))).map((r) => r.status),
    ).toEqual(["delete_failed", "delete_failed"]);
    expect(
      await f.app.db.read((r) =>
        r.dailyUploadCount(
          "u:" + file!.owner_id,
          new Date().toISOString().slice(0, 10),
        ),
      ),
    ).toBe(0);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    await close();
  }
});

test("one failed target does not prevent publication and retries with the same operation ID", async () => {
  const { f, leases, close } = await copies();
  const ids: string[] = [];
  const original = leases[0]!.runtime.write.bind(leases[0]!.runtime);
  const spy = spyOn(leases[0]!.runtime, "write").mockImplementation(
    async (input, ctx) => {
      ids.push(input.operationId);
      if (ids.length === 1) throw new PluginError("NETWORK", "offline", true);
      return original(input, ctx);
    },
  );
  try {
    const response = await f.upload();
    expect(response.ok).toBe(true);
    const image = await response.json();
    await f.app.files.tasks.drain();
    await f.app.db.transaction(async (r) => {
      for (const task of await r.tasks(image.id))
        if (task.status === "pending")
          await r.saveTask({ ...task, next_run_at: Date.now() });
    });
    await f.app.files.sweep();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(
      (await f.app.db.read((r) => r.replicas(image.id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
  } finally {
    spy.mockRestore();
    await close();
  }
});

test("simultaneous successful copies publish once and consume one daily upload", async () => {
  const { f, leases, close } = await copies();
  const release = gate(),
    entered = [gate(), gate()];
  const spies = leases.map((lease, i) => {
    const original = lease.runtime.write.bind(lease.runtime);
    return spyOn(lease.runtime, "write").mockImplementation(
      async (input, ctx) => {
        entered[i]!.release();
        await release.promise;
        return original(input, ctx);
      },
    );
  });
  try {
    const pending = f.upload();
    await Promise.all(entered.map((g) => g.promise));
    release.release();
    const response = await pending;
    expect(response.ok).toBe(true);
    const image = await response.json();
    await f.app.files.tasks.drain();
    const file = (await f.app.db.read((r) => r.file(image.id)))!;
    expect(
      await f.app.db.read((r) =>
        r.dailyUploadCount(
          "u:" + file.owner_id,
          new Date().toISOString().slice(0, 10),
        ),
      ),
    ).toBe(1);
    expect(
      (await f.app.db.read((r) => r.tasks(image.id))).map((t) => t.attempts),
    ).toEqual([1, 1]);
  } finally {
    release.release();
    await f.app.files.tasks.drain();
    spies.forEach((spy) => spy.mockRestore());
    await close();
  }
});

test("cancellation before publication preserves late write locations for cleanup", async () => {
  const f = await fixture();
  const source = (await f.app.plugins.storageViews())[0]!;
  const lease = f.app.plugins.acquire(source.id, "storage");
  const original = lease.runtime.write.bind(lease.runtime),
    written = gate(),
    release = gate();
  const spy = spyOn(lease.runtime, "write").mockImplementation(
    async (input, ctx) => {
      const result = await original(input, ctx);
      written.release();
      await release.promise;
      return result;
    },
  );
  try {
    const controller = new AbortController();
    const pending = upload(f, controller.signal);
    await written.promise;
    controller.abort();
    expect((await pending).ok).toBe(false);
    release.release();
    await f.app.files.tasks.drain();
    const [unpublished] = await f.app.db.read((r) => r.files(10, 0));
    const [writeTask] = await f.app.db.read((r) => r.tasks(unpublished!.id));
    const storedPath = join(
      lease.record.config_json.root as string,
      unpublished!.storage_key,
    );
    expect(await Bun.file(storedPath).exists()).toBe(true);
    expect(writeTask).toMatchObject({
      status: "success",
      attempts: 1,
      last_error: null,
      next_run_at: null,
    });
    await f.app.files.sweep();
    const [file] = await f.app.db.read((r) => r.files(10, 0));
    expect(file).toBeUndefined();
    expect(await Bun.file(storedPath).exists()).toBe(false);
    expect(await f.app.db.read((r) => r.replicas(unpublished!.id))).toEqual([]);
  } finally {
    release.release();
    await f.app.files.tasks.drain();
    spy.mockRestore();
    await lease.release();
    await f.close();
  }
});

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await Bun.sleep(1);
  }
}

test("admission shares slots across files and lowering concurrency only affects new tasks", async () => {
  const { f, leases, close } = await copies();
  const entered: Array<{ id: string; release: () => void }> = [];
  let finishAll = false,
    active = 0,
    peak = 0;
  const spies = leases.map((lease) => {
    const original = lease.runtime.write.bind(lease.runtime);
    return spyOn(lease.runtime, "write").mockImplementation(
      async (input, ctx) => {
        const barrier = gate();
        entered.push({ id: input.fileId, release: barrier.release });
        active++;
        peak = Math.max(peak, active);
        try {
          if (!finishAll) await barrier.promise;
          return await original(input, ctx);
        } finally {
          active--;
        }
      },
    );
  });
  const uploads: Array<Promise<Response>> = [];
  try {
    f.app.config.writeConcurrency = 2;
    await f.app.files.tasks.pause();
    uploads.push(f.upload(), f.upload());
    await until(
      async () =>
        (await f.app.db.read((r) => r.filesInStates(["preparing"]))).length ===
        2,
    );
    f.app.files.tasks.resume();
    await until(() => entered.length === 2);
    expect(new Set(entered.map((item) => item.id)).size).toBe(2);
    expect(active).toBe(2);
    f.app.config.writeConcurrency = 1;
    entered[0]!.release();
    await until(() => active === 1);
    await f.app.files.tasks.dispatch();
    expect(entered).toHaveLength(2);
    finishAll = true;
    entered[1]!.release();
    for (const response of await Promise.all(uploads))
      expect(response.status).toBe(201);
    await f.app.files.tasks.drain();
    expect(entered).toHaveLength(4);
    expect(peak).toBe(2);
  } finally {
    finishAll = true;
    entered.forEach((item) => item.release());
    f.app.files.tasks.resume();
    await Promise.allSettled(uploads);
    await f.app.files.tasks.drain();
    spies.forEach((spy) => spy.mockRestore());
    await close();
  }
});

test("closing the executor wakes an upload whose first write is queued", async () => {
  const f = await fixture();
  let pending: Promise<Response> | undefined;
  try {
    await f.app.files.tasks.pause();
    pending = f.upload();
    await until(
      async () =>
        (await f.app.db.read((r) => r.filesInStates(["preparing"]))).length ===
        1,
    );
    await f.app.files.tasks.close();
    expect((await pending).status).toBe(503);
    const [file] = await f.app.db.read((r) => r.files(10, 0));
    expect(file!.status).toBe("failed");
    expect((await f.app.db.read((r) => r.tasks(file!.id)))[0]!.attempts).toBe(
      0,
    );
  } finally {
    await pending;
    await f.close();
  }
});

test("confirmed writes stay successful when completion is interrupted", async () => {
  const f = await fixture({
    afterWrite: async () => {
      throw new Error("Completion interrupted after storage returned");
    },
  });
  const source = (await f.app.plugins.storageViews())[0]!;
  const lease = f.app.plugins.acquire(source.id, "storage");
  const spy = spyOn(lease.runtime, "write");
  try {
    const response = await f.upload();
    expect(response.status).toBe(201);
    const image = await response.json();
    await f.app.files.tasks.drain();
    const [before] = await f.app.db.read((r) => r.tasks(image.id));
    expect(before!.status).toBe("success");
    expect(before!.last_error).toBeNull();
    expect(before!.next_run_at).toBeNull();
    expect((await f.app.db.read((r) => r.replicas(image.id)))[0]!.status).toBe(
      "ready",
    );
    await f.app.files.sweep();
    const [after] = await f.app.db.read((r) => r.tasks(image.id));
    expect(after!.id).toBe(before!.id);
    expect(after!.status).toBe("success");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("a successful storage response after the task timeout is committed without retry", async () => {
  const f = await fixture();
  const source = (await f.app.plugins.storageViews())[0]!;
  const lease = f.app.plugins.acquire(source.id, "storage");
  const original = lease.runtime.write.bind(lease.runtime);
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const [callback, delay, ...values] = args;
    if (delay === 120_000) expire = () => callback(...values);
    return schedule(...args);
  }) as typeof setTimeout);
  const write = spyOn(lease.runtime, "write").mockImplementation(
    async (input, ctx) => {
      const result = await original(input, ctx);
      expect(expire).toBeDefined();
      expire!();
      expect(ctx.signal.aborted).toBe(true);
      return result;
    },
  );
  try {
    const response = await f.upload();
    expect(response.status).toBe(201);
    const image = await response.json();
    await f.app.files.sweep();
    const [task] = await f.app.db.read((r) => r.tasks(image.id));
    expect(task).toMatchObject({
      status: "success",
      attempts: 1,
      last_error: null,
      next_run_at: null,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await f.app.db.read((r) => r.replicas(image.id)))[0]!.status).toBe(
      "ready",
    );
    timer.mockRestore();
    write.mockRestore();
    await lease.release();
    await f.restart();
    expect(await f.app.db.read((r) => r.task(task!.id))).toMatchObject({
      status: "success",
      attempts: 1,
    });
  } finally {
    timer.mockRestore();
    write.mockRestore();
    await lease.release();
    await f.close();
  }
});
