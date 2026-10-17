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
