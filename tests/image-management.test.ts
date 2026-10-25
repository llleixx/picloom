import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { dateBoundary, localDate } from "../web/src/lib/date-range";

test("date boundaries use calendar days and invalid dates are rejected", () => {
  expect(dateBoundary("2026-02-28", true)).toBe(dateBoundary("2026-03-01"));
  expect(() => dateBoundary("2026-02-30")).toThrow();
  expect(localDate(new Date(2026, 0, 3))).toBe("2026-01-03");
});
test("time filters use inclusive start/exclusive end and consistent counts", async () => {
  const f = await fixture();
  try {
    const a = await (await f.upload()).json(),
      b = await (await f.upload()).json();
    await f.app.db.transaction(async (r) => {
      for (const [id, time] of [
        [a.id, 1000],
        [b.id, 2000],
      ] as const) {
        const file = (await r.file(id))!;
        await r.saveFile({ ...file, created_at: time }, file.status);
      }
    });
    const response = await f.request(
      "/api/files?createdFrom=1000&createdBefore=2000&status=ready&mimeType=image/png",
    );
    expect(response.headers.get("X-Total-Count")).toBe("1");
    expect((await response.json()).map((f: any) => f.id)).toEqual([a.id]);
    const exact = await f.app.db.read(async (r) => ({
      items: await r.files(30, 0, { createdFrom: 2000 }),
      count: await r.countFiles({ createdFrom: 2000 }),
    }));
    expect(exact.count).toBe(1);
    expect(exact.items[0]!.id).toBe(b.id);
    for (const query of [
      "createdFrom=-1",
      "createdBefore=x",
      "createdFrom=2000&createdBefore=1000",
      "createdFrom=",
    ])
      expect((await f.request("/api/files?" + query)).status).toBe(400);
  } finally {
    await f.close();
  }
});
test("batch delete checks admin and CSRF, reports partial results and is idempotent", async () => {
  const f = await fixture();
  try {
    const a = await (await f.upload()).json(),
      b = await (await f.upload()).json();
    const path = "/api/files/batch-delete";
    expect(
      (
        await handler(f.app)(
          new Request("http://localhost" + path, {
            method: "POST",
            headers: { cookie: f.cookie },
            body: JSON.stringify({ ids: [a.id] }),
          }),
        )
      ).status,
    ).toBe(403);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "uploader" })
    ).json();
    expect(
      (await f.request(path, "POST", { ids: [a.id] }, token.token)).status,
    ).toBe(403);
    expect((await f.request(path, "POST", { ids: [a.id, a.id] })).status).toBe(
      400,
    );
    expect((await f.request(path, "POST", { ids: [] })).status).toBe(400);
    const result = await (
      await f.request(path, "POST", { ids: [a.id, "missing", b.id] })
    ).json();
    expect(result.results).toEqual([
      { id: a.id, accepted: true },
      { id: "missing", accepted: false, error: "NOT_FOUND" },
      { id: b.id, accepted: true },
    ]);
    expect((await f.request(new URL(a.url).pathname)).status).toBe(404);
    expect(
      (await (await f.request(path, "POST", { ids: [a.id] })).json()).results[0]
        .accepted,
    ).toBe(true);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(a.id)))!.status).toBe("deleted");
  } finally {
    await f.close();
  }
});

test("abnormal images use final failures across sources and keep counts consistent", async () => {
  const f = await fixture();
  try {
    const file = await (await f.upload()).json();
    await f.upload(); // A healthy file must not match.
    const primary = (await f.app.db.read((r) => r.replicas(file.id)))[0]!;
    const response = await f.request("/api/storage-sources", "POST", {
      pluginId: "builtin.local",
      version: "1.0.0",
      name: "Other source",
      config: { root: `${f.root}/other` },
    });
    expect(response.status).toBe(201);
    const source = await response.json();
    const replica = {
      ...primary,
      id: crypto.randomUUID(),
      storage_instance_id: source.id,
    };
    const task = {
      ...(await f.app.db.read((r) => r.tasks(file.id)))[0]!,
      id: crypto.randomUUID(),
      replica_id: replica.id,
      status: "failed" as const,
    };
    await f.app.db.transaction(async (r) => {
      await r.insertReplica(replica);
      await r.insertTask(task);
    });
    for (const status of ["write_failed", "delete_failed"] as const) {
      await f.app.db.transaction(async (r) => {
        await r.saveReplica({ ...replica, status });
        await r.saveTask({
          ...task,
          kind: status === "write_failed" ? "write" : "delete",
        });
      });
      for (const query of [
        "status=attention",
        `status=attention&source=${source.id}`,
        `status=attention&source=${primary.storage_instance_id}`,
      ]) {
        const result = await f.request(`/api/files?${query}&limit=1`);
        expect(result.status).toBe(200);
        expect(result.headers.get("X-Total-Count")).toBe("1");
        const items = await result.json();
        expect(items.map((item: { id: string }) => item.id)).toEqual([file.id]);
        expect(items[0]).toMatchObject({ status: "ready", replicaIssue: true });
      }
      const normalSource = await (
        await f.request(
          `/api/files?status=ready&source=${primary.storage_instance_id}`,
        )
      ).json();
      expect(
        normalSource.find((item: { id: string }) => item.id === file.id)
          .replicaIssue,
      ).toBe(true);
      for (const taskStatus of ["pending", "running", "cancelled"] as const) {
        await f.app.db.transaction((r) =>
          r.saveTask({
            ...task,
            kind: status === "write_failed" ? "write" : "delete",
            status: taskStatus,
            next_run_at: taskStatus === "pending" ? Date.now() + 60_000 : null,
          }),
        );
        const result = await f.request("/api/files?status=attention");
        expect(result.headers.get("X-Total-Count")).toBe("0");
        expect(await result.json()).toEqual([]);
      }
    }
    // An unfinished source matches deletion failure, but a cleaned source does not.
    await f.app.db.transaction(async (r) => {
      const current = (await r.file(file.id))!;
      await r.saveFile(
        { ...current, status: "delete_failed", last_error: "DELETE_FAILED" },
        current.status,
      );
      await r.saveReplica({ ...replica, status: "delete_failed" });
      await r.saveTask({ ...task, kind: "delete" });
      await r.saveReplica({ ...primary, status: "deleted" });
    });
    const unfinished = await f.request(
      `/api/files?status=delete_failed&source=${source.id}`,
    );
    expect(unfinished.status).toBe(200);
    expect(unfinished.headers.get("X-Total-Count")).toBe("1");
    expect((await unfinished.json())[0]).toMatchObject({
      status: "delete_failed",
      replicaIssue: true,
    });
    const cleaned = await f.request(
      `/api/files?status=delete_failed&source=${primary.storage_instance_id}`,
    );
    expect(cleaned.headers.get("X-Total-Count")).toBe("0");
    await f.app.db.transaction(async (r) => {
      const current = (await r.file(file.id))!;
      await r.saveFile({ ...current, status: "deleting" }, current.status);
    });
    expect(
      (await f.request("/api/files?status=attention")).headers.get(
        "X-Total-Count",
      ),
    ).toBe("1");
    await f.app.db.transaction(async (r) => {
      const current = (await r.file(file.id))!;
      await r.saveReplica({ ...replica, status: "deleted" });
      await r.saveFile(
        {
          ...current,
          status: "deleted",
          last_error: null,
          deleted_at: Date.now(),
        },
        current.status,
      );
    });
    expect(
      (await f.request("/api/files?status=attention")).headers.get(
        "X-Total-Count",
      ),
    ).toBe("0");
    const history = await f.request(
      `/api/files?status=deleted&source=${source.id}`,
    );
    expect(history.headers.get("X-Total-Count")).toBe("1");
    expect((await history.json())[0]).toMatchObject({
      id: file.id,
      status: "deleted",
      replicaIssue: false,
    });
  } finally {
    await f.close();
  }
});
