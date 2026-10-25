import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { entity } from "../src/persistence/port";
import { localDayBoundaries } from "../web/src/lib/date-range";
import type { SystemStatistics } from "../shared/api";

const statisticsUrl = (days = 30, boundaries = localDayBoundaries(days)) =>
  "/api/system/statistics?" +
  new URLSearchParams(boundaries.map((value) => ["boundary", String(value)]));

test("statistics aggregate ready images by creation date and reflect deletion", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await handler(f.app)(
          new Request("http://localhost/api/system/statistics"),
        )
      ).status,
    ).toBe(401);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request("/api/system/statistics", "GET", undefined, token.token))
        .status,
    ).toBe(403);
    expect((await f.request(statisticsUrl(365))).status).toBe(400);
    const upload = await (await f.upload()).json();
    const record = (await f.app.db.read((r) => r.file(upload.id)))!;
    // An imported object may not yet have size metadata.
    const imported = {
      ...record,
      ...entity(),
      logical_key: "unknown.png",
      storage_key: "unknown.png",
      origin_kind: "import" as const,
      origin_user_id: record.owner_id,
      byte_size: null,
      temp_path: null,
      temp_status: "cleaned" as const,
    };
    await f.app.db.transaction(async (r) => {
      await r.insertFile(imported);
      expect(await r.insertFileIfPathFree({ ...imported, ...entity() })).toBe(
        false,
      );
      // Unblocking and resaving do not represent another addition.
      await r.saveFile({ ...record, status: "blocked" }, "ready");
      await r.saveFile(record, "blocked");
    });
    let stats: SystemStatistics = await (
      await f.request(statisticsUrl(7))
    ).json();
    expect(stats.trend).toHaveLength(7);
    expect(stats.readyFiles).toBe(2);
    expect(stats.unknownBytes).toBe(1);
    expect(stats.trend.reduce((n, d) => n + d.uploads + d.imports, 0)).toBe(2);
    const today = stats.trend.at(-1)!;
    expect(today.uploads).toBe(1);
    expect(today.imports).toBe(1);
    expect(today.uploadBytes).toBe(f.png.byteLength);
    expect(today.unknownBytes).toBe(1);
    const query = `createdFrom=${today.day}&createdBefore=${today.before}`;
    const listed = await (
      await f.request(`/api/files?status=ready&${query}&sort=size&order=desc`)
    ).json();
    expect(listed.map((x: { id: string }) => x.id)).toEqual([
      upload.id,
      imported.id,
    ]);
    expect((await f.request(`/api/files/${upload.id}`, "DELETE")).status).toBe(
      202,
    );
    await f.app.files.sweep();
    await f.restart();
    stats = await (await f.request(statisticsUrl(7))).json();
    expect(stats.readyFiles).toBe(1);
    expect(stats.trend.at(-1)!.uploads).toBe(0);
    expect(stats.trend.at(-1)!.imports).toBe(1);
    expect(
      (await (await f.request(`/api/files?status=ready&${query}`)).json())
        .length,
    ).toBe(1);
    expect(
      (await f.request("/api/files?createdFrom=2&createdBefore=1")).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});

test("attention counts distinct images and storage retains pending and failed replica accounting", async () => {
  const f = await fixture();
  try {
    const upload = await (await f.upload()).json();
    await f.app.db.transaction(async (r) => {
      const file = (await r.file(upload.id))!;
      await r.saveFile({ ...file, status: "blocked" }, "ready");
      expect(await r.countFiles({ status: "attention" })).toBe(1);
      const pipeline = {
        ...entity(),
        name: "Post-save",
        kind: "post_save" as const,
        config_version: 1,
      };
      await r.insertPipeline(pipeline);
      await r.insertTask({
        ...entity(),
        kind: "action",
        file_id: file.id,
        replica_id: null,
        pipeline_id: pipeline.id,
        status: "failed",
        attempts: 1,
        next_run_at: null,
        last_error: "private failure",
      });
    });
    const stats: SystemStatistics = await (
      await f.request(statisticsUrl())
    ).json();
    expect(stats.attentionFiles).toBe(1);
    expect(stats.readyFiles).toBe(0);
    expect(stats.originalBytes).toBe(0);
    expect(stats.storage.reduce((n, s) => n + s.bytes, 0)).toBe(
      f.png.byteLength,
    );
    expect(stats.trend.reduce((n, d) => n + d.uploads, 0)).toBe(0);
    const list = await (await f.request("/api/files?status=attention")).json();
    expect(list.map((x: { id: string }) => x.id)).toEqual([upload.id]);
    expect(JSON.stringify(stats)).not.toContain("private failure");
    expect(list[0]).toMatchObject({ postSaveIssue: true, replicaIssue: false });
    // Post-save failures remain actionable after unblocking, but not during cleanup.
    for (const status of ["ready", "failed", "deleting", "deleted"] as const) {
      await f.app.db.transaction(async (r) => {
        const file = (await r.file(upload.id))!;
        await r.saveFile(
          {
            ...file,
            status,
            deleted_at: status === "deleted" ? Date.now() : null,
          },
          file.status,
        );
      });
      const result = await f.request("/api/files?status=attention");
      expect(result.headers.get("X-Total-Count")).toBe(
        status === "ready" ? "1" : "0",
      );
    }
  } finally {
    await f.close();
  }
});

test("local-day buckets include midnight once and preserve a 23-hour day", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    const base = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    const boundaries = [
      "2026-03-07T00:00:00-05:00",
      "2026-03-08T00:00:00-05:00",
      "2026-03-09T00:00:00-04:00",
      "2026-03-10T00:00:00-04:00",
      "2026-03-11T00:00:00-04:00",
      "2026-03-12T00:00:00-04:00",
      "2026-03-13T00:00:00-04:00",
      "2026-03-14T00:00:00-04:00",
    ].map(Date.parse);
    for (const [index, time] of [
      boundaries[0]! - 1,
      boundaries[0]!,
      boundaries[1]!,
      boundaries[2]! - 1,
      boundaries[2]!,
      boundaries[7]!,
    ].entries()) {
      await f.app.db.transaction((r) =>
        r.insertFile({
          ...base,
          ...entity(),
          created_at: time,
          logical_key: `boundary-${index}.png`,
          storage_key: `boundary-${index}.png`,
          origin_kind: "import",
          origin_user_id: base.owner_id,
        }),
      );
    }
    const response = await f.request(statisticsUrl(7, boundaries));
    expect(response.status).toBe(200);
    const stats: SystemStatistics = await response.json();
    expect(stats.trend.map((d) => d.imports)).toEqual([1, 2, 1, 0, 0, 0, 0]);
    expect(stats.trend[1]!.before - stats.trend[1]!.day).toBe(23 * 3600000);
    const day = stats.trend[1]!;
    const files = await (
      await f.request(
        `/api/files?createdFrom=${day.day}&createdBefore=${day.before}`,
      )
    ).json();
    expect(files).toHaveLength(2);
    for (const invalid of [
      boundaries.slice(1),
      boundaries.map((n, i) => (i === 1 ? boundaries[0]! : n)),
      boundaries.map((n, i) => (i === 1 ? NaN : n)),
    ])
      expect((await f.request(statisticsUrl(7, invalid))).status).toBe(400);
  } finally {
    await f.close();
  }
});
