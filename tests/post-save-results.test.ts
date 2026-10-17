import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { handler } from "../src/http/app";
import { hash } from "../src/core/auth";
import type { PostSavePlugin } from "../src/plugins/api";

async function pipeline(
  f: Awaited<ReturnType<typeof fixture>>,
  execute: PostSavePlugin["execute"],
) {
  let following = 0;
  for (const [id, fn] of [
    ["test.decision", execute],
    [
      "test.following",
      async () => {
        following++;
        return { status: "pass" as const };
      },
    ],
  ] as const)
    f.app.plugins.register({
      id,
      name: id,
      kind: "processor",
      version: "1",
      apiVersion: 1,
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          async createInstance() {
            return { execute: fn };
          },
        },
      },
    });
  const chain = await f.app.configuration.savePipeline({
    name: "Review",
    kind: "post_save",
    steps: ["test.decision", "test.following"].map((pluginId) => ({
      pluginId,
      version: "1",
      config: {},
    })),
  });
  const profile = await f.app.configuration.profileEditor(f.profileId);
  await f.app.configuration.saveProfileEditor(
    {
      ...profile,
      postSavePipelineId: chain.id,
      expectedVersion: profile.configVersion,
    },
    profile.id,
  );
  return () => following;
}

test("block stops the chain, denies cached public access, preserves copies and allows admin recovery", async () => {
  const f = await fixture();
  try {
    const following = await pipeline(f, async () => ({
      status: "block",
      details: { label: "test", score: 82, nested: { suggestion: "Review" } },
    }));
    const source = await f.app.plugins.save({
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Redundant",
      config: { root: join(f.root, "redundant") },
    });
    const profile = await f.app.configuration.profile(f.profileId);
    const group = await f.app.configuration.group(profile.storageGroupId);
    await f.app.configuration.saveGroup(
      {
        ...group,
        expectedVersion: group.configVersion,
        redundancyCount: 1,
        members: [...group.members, { instanceId: source.id, weight: 1 }],
      },
      group.id,
    );
    const chunk = await (
      await f.request("/api/uploads", "POST", {
        profileId: f.profileId,
        size: f.png.length,
      })
    ).json();
    expect(
      (
        await handler(f.app)(
          new Request("http://localhost/api/uploads/" + chunk.id + "/parts/0", {
            method: "PUT",
            headers: { "x-upload-key": chunk.uploadKey },
            body: new Uint8Array(f.png),
          }),
        )
      ).status,
    ).toBe(200);
    const uploaded = await (
      await f.request("/api/uploads/" + chunk.id + "/complete", "POST")
    ).json();
    expect(
      (await (await f.request("/api/files/" + uploaded.id)).json())
        .backgroundPending,
    ).toBe(true);
    const path = new URL(uploaded.url).pathname;
    await (await f.request(path + "?w=20")).arrayBuffer();
    const write = (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
      (t) => t.kind === "write",
    )!;
    await f.app.db.transaction((r) =>
      r.saveTask({ ...write, next_run_at: Date.now() + 60000 }),
    );
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(uploaded.id)))!.status).toBe(
      "blocked",
    );
    expect(following()).toBe(0);
    const action = (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
      (t) => t.kind === "action",
    )!;
    expect(action.status).toBe("success");
    expect(action.attempts).toBe(1);
    const report = (await (await f.request("/api/files/" + uploaded.id)).json())
      .processingResults;
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({
      pluginId: "test.decision",
      pluginVersion: "1",
      status: "block",
      details: { label: "test", score: 82 },
    });
    expect(
      (await (await f.request("/api/files?status=blocked")).json())[0]
        .processingResults,
    ).toBeUndefined();

    for (const url of [path, path + "?w=20"]) {
      expect((await f.request(url)).status).toBe(404);
      expect((await f.request(url, "HEAD")).status).toBe(404);
    }
    expect(
      (await f.request("/api/files?status=blocked")).headers.get(
        "x-total-count",
      ),
    ).toBe("1");
    const preview = await f.request("/api/files/" + uploaded.id + "/preview");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
    await f.request("/api/users", "POST", {
      username: "member",
      password: "member-password-123",
      role: "member",
    });
    const login = await f.app.auth.login(
      "member",
      "member-password-123",
      "member-test",
    );
    // Give the member ownership to check detail redaction, not just access denial.
    await f.app.db.transaction(async (r) => {
      const row = (await r.file(uploaded.id))!;
      const members = await r.users(20, 0);
      row.owner_id = members.find((u) => u.username === "member")!.id;
      await r.saveFile(row, row.status);
    });
    const memberDetail = await handler(f.app)(
      new Request("http://localhost/api/files/" + uploaded.id, {
        headers: { cookie: f.app.auth.cookie(login.secret) },
      }),
    );
    expect(memberDetail.status).toBe(200);
    expect((await memberDetail.json()).processingResults).toBeUndefined();
    for (const [suffix, method] of [
      ["preview", "GET"],
      ["unblock", "POST"],
    ]) {
      expect(
        (
          await handler(f.app)(
            new Request(
              "http://localhost/api/files/" + uploaded.id + "/" + suffix,
              {
                method,
                headers: {
                  cookie: f.app.auth.cookie(login.secret),
                  "x-csrf-token": f.app.auth.csrf(hash(login.secret)),
                },
              },
            ),
          )
        ).status,
      ).toBe(403);
    }
    await f.app.db.transaction((r) => r.saveTask({ ...write, next_run_at: 0 }));
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.replicas(uploaded.id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))!.temp_path,
    ).toBeNull();
    await f.restart();
    expect(
      (await (await f.request("/api/files/" + uploaded.id)).json())
        .processingResults,
    ).toEqual(report);

    expect((await f.request(path)).status).toBe(404);
    const repeated = await f.request(
      "/api/uploads/" + chunk.id + "/complete",
      "POST",
    );
    expect(repeated.ok).toBe(true);
    expect((await repeated.json()).id).toBe(uploaded.id);
    expect(
      (await f.request("/api/files/" + uploaded.id + "/unblock", "POST"))
        .status,
    ).toBe(200);
    const restored = await f.request(path);
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();
    expect(
      (await (await f.request("/api/files/" + uploaded.id)).json())
        .processingResults,
    ).toEqual(report);
    expect(
      (await f.request("/api/files/" + uploaded.id + "/unblock", "POST"))
        .status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test("delete records successful action and existing cleanup retries across restart", async () => {
  let fail = true;
  const f = await fixture({
    beforeDelete: async () => {
      if (fail) throw new Error("failure");
    },
  });
  try {
    const following = await pipeline(f, async () => ({ status: "delete" }));
    const uploaded = await (await f.upload()).json();
    await f.app.files.sweep();
    expect(following()).toBe(0);
    expect(
      (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
        (t) => t.kind === "action",
      )!.status,
    ).toBe("success");
    expect((await f.request(new URL(uploaded.url).pathname)).status).toBe(404);
    await f.app.files.sweep();
    fail = false;
    await f.app.db.transaction(async (r) => {
      for (const t of await r.tasks(uploaded.id))
        if (t.kind === "delete") await r.saveTask({ ...t, next_run_at: 0 });
    });
    await f.restart();
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(uploaded.id)))!.status).toBe(
      "deleted",
    );
    expect(
      (await f.app.db.read((r) => r.replicas(uploaded.id))).every(
        (r) => r.status === "deleted",
      ),
    ).toBe(true);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
    expect(await readdir(join(f.root, "cache"))).not.toContain(uploaded.id);
  } finally {
    await f.close();
  }
});

test("execution errors retry, pass continues, and an interrupted decision never resurrects deletion", async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    const following = await pipeline(f, async () => {
      if (++attempts === 1) throw new Error("temporary");
      return { status: "pass" };
    });
    const uploaded = await (await f.upload()).json();
    await f.app.files.sweep();
    const task = (await f.app.db.read((r) => r.tasks(uploaded.id)))[0]!;
    expect(task.status).toBe("pending");
    expect((await f.app.db.read((r) => r.file(uploaded.id)))!.status).toBe(
      "ready",
    );
    await f.app.db.transaction((r) => r.saveTask({ ...task, next_run_at: 0 }));
    await f.app.files.sweep();
    expect(following()).toBe(1);
    expect((await f.app.db.read((r) => r.task(task.id)))!.attempts).toBe(2);
  } finally {
    await f.close();
  }

  const race = await fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (release = r));
  try {
    await pipeline(race, async () => {
      enter();
      await gate;
      return { status: "block" };
    });
    const uploaded = await (await race.upload()).json();
    const running = race.app.files.sweep();
    await entered;
    await race.app.files.delete(uploaded.id);
    release();
    await running;
    expect(
      (await race.app.db.read((r) => r.file(uploaded.id)))!.status,
    ).not.toBe("blocked");
    expect(
      (await race.app.db.read((r) => r.tasks(uploaded.id))).find(
        (t) => t.kind === "action",
      )!.status,
    ).toBe("cancelled");
  } finally {
    release?.();
    await race.close();
  }
});

test("private preview cancels its storage stream when the final state query fails", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    expect(
      (await (await f.request("/api/files/" + uploaded.id)).json())
        .backgroundPending,
    ).toBe(false);
    const row = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    const replica = (await f.app.db.read((r) => r.replicas(uploaded.id)))[0]!;
    const lease = f.app.plugins.acquire(replica.storage_instance_id, "storage");
    let cancelled = false;
    let storageOpened = false;
    const storage = spyOn(lease.runtime, "read").mockImplementation(
      async () => {
        storageOpened = true;
        return {
          type: "stream" as const,
          stream: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    );
    const originalRead = f.app.db.read.bind(f.app.db);
    const read = spyOn(f.app.db, "read").mockImplementation(async (fn) => {
      // Fail the state recheck after storage opens, independent of earlier read scopes.
      if (storageOpened) throw new Error("Injected state read failure");
      return originalRead(fn);
    });
    try {
      await expect(
        f.app.files.preview(row.id, new AbortController().signal),
      ).rejects.toThrow("Injected state read failure");
      expect(cancelled).toBe(true);
    } finally {
      read.mockRestore();
      storage.mockRestore();
      await lease.release();
    }
  } finally {
    await f.close();
  }
});

test("Post-save summaries commit only on success and invalid results fail without retry", async () => {
  const f = await fixture();
  try {
    let invalid = false;
    await pipeline(f, async () => ({
      status: "pass",
      details: { value: invalid ? "x".repeat(65536) : "ok" },
    }));
    const profile = await f.app.db.read((r) => r.profile(f.profileId));
    const steps = await f.app.db.read((r) =>
      r.steps(profile!.post_save_pipeline_id!),
    );
    const lease = f.app.plugins.acquire(
      steps[1]!.plugin_instance_id,
      "post_save",
    );
    const execute = spyOn(lease.runtime, "execute").mockRejectedValueOnce(
      new Error("Later step failed"),
    );
    await lease.release();
    const uploaded = await (await f.upload()).json();
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))!
        .processing_results_json,
    ).toBeNull();
    const task = (await f.app.db.read((r) => r.tasks(uploaded.id))).find(
      (t) => t.kind === "action",
    )!;
    expect(task.status).toBe("pending");
    execute.mockRestore();
    await f.app.db.transaction((r) =>
      r.saveTask({ ...task, next_run_at: Date.now() }),
    );
    await f.app.files.sweep();
    expect(
      (await f.app.db.read((r) => r.file(uploaded.id)))!
        .processing_results_json,
    ).toHaveLength(1);
    invalid = true;
    const oversized = await (await f.upload()).json();
    await f.app.files.sweep();
    const failed = (await f.app.db.read((r) => r.tasks(oversized.id)))[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.last_error).toContain("PROCESSING_RESULT_INVALID");
    expect(
      (await f.app.db.read((r) => r.file(oversized.id)))!
        .processing_results_json,
    ).toBeNull();
    expect((await f.app.db.read((r) => r.file(oversized.id)))!.status).toBe(
      "ready",
    );
  } finally {
    await f.close();
  }
});
