import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { entity } from "../src/persistence/port";

async function setup() {
  const f = await fixture();
  const uploaded = await (await f.upload()).json();
  const file = (await f.app.db.read((r) => r.file(uploaded.id)))!;
  const replica = (await f.app.db.read((r) => r.replicas(file.id)))[0]!;
  const original = (await f.app.db.read((r) =>
    r.instance(replica.storage_instance_id),
  ))!;
  const copy = { ...original, ...entity(), name: "Fallback" };
  await f.app.db.transaction(async (r) => {
    await r.saveInstance(copy);
    await r.insertReplica({
      ...replica,
      ...entity(),
      storage_instance_id: copy.id,
      role: "redundant",
    });
  });
  await f.app.plugins.activate(copy.id);
  f.app.files.random = () => 0;
  const first = f.app.plugins.acquire(original.id, "storage");
  const second = f.app.plugins.acquire(copy.id, "storage");
  return {
    f,
    file,
    first,
    second,
    async close() {
      await first.release();
      await second.release();
      await f.close();
    },
  };
}
test("failed read or first chunk falls back; all failures return 503 without changing replica state", async () => {
  const t = await setup();
  const first = spyOn(t.first.runtime, "read").mockRejectedValue(
    new Error("private backend URL"),
  );
  const second = spyOn(t.second.runtime, "read");
  try {
    const response = await t.f.app.files.access(
      t.file,
      {},
      new AbortController().signal,
    );
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    first.mockImplementation(async () => ({
      type: "stream",
      stream: new ReadableStream({
        pull(c) {
          c.error(new Error("first chunk"));
        },
      }),
    }));
    const preview = await t.f.app.files.preview(
      t.file.id,
      new AbortController().signal,
    );
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(second).toHaveBeenCalledTimes(2);
    second.mockRejectedValue(new Error("second failed"));
    await expect(
      t.f.app.files.access(t.file, {}, new AbortController().signal),
    ).rejects.toMatchObject({ status: 503 });
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(3);
    expect(
      (await t.f.app.db.read((r) => r.replicas(t.file.id))).every(
        (r) => r.status === "ready",
      ),
    ).toBe(true);
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("redirects commit immediately, while forced stream can fall back", async () => {
  const t = await setup();
  const first = spyOn(t.first.runtime, "read").mockResolvedValue({
    type: "redirect",
    url: "https://example.com/image.png",
  });
  const second = spyOn(t.second.runtime, "read");
  try {
    expect(
      (await t.f.app.files.access(t.file, {}, new AbortController().signal))
        .status,
    ).toBe(302);
    expect(second).not.toHaveBeenCalled();
    const preview = await t.f.app.files.preview(
      t.file.id,
      new AbortController().signal,
    );
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(second).toHaveBeenCalledTimes(1);
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("midstream failure does not retry another replica", async () => {
  const t = await setup();
  let fail!: () => void;
  const first = spyOn(t.first.runtime, "read").mockImplementation(async () => ({
    type: "stream",
    stream: new ReadableStream<Uint8Array>(
      {
        start(c) {
          c.enqueue(new Uint8Array([1]));
          fail = () => c.error(new Error("disconnected"));
        },
      },
      { highWaterMark: 0 },
    ),
  }));
  const second = spyOn(t.second.runtime, "read");
  try {
    const response = await t.f.app.files.access(
      t.file,
      {},
      new AbortController().signal,
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    fail();
    await expect(reader.read()).rejects.toThrow("disconnected");
    reader.releaseLock();
    expect(second).not.toHaveBeenCalled();
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("abort during first read cancels the source and does not try another replica", async () => {
  const t = await setup();
  const abort = new AbortController();
  let started!: () => void;
  const opened = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const first = spyOn(t.first.runtime, "read").mockImplementation(async () => ({
    type: "stream",
    stream: new ReadableStream<Uint8Array>({
      pull() {
        started();
      },
      cancel() {
        cancelled = true;
      },
    }),
  }));
  const second = spyOn(t.second.runtime, "read");
  try {
    const pending = t.f.app.files.access(t.file, {}, abort.signal);
    await opened;
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("deletion during fallback prevents publication and cancels the selected stream", async () => {
  const t = await setup();
  const first = spyOn(t.first.runtime, "read").mockRejectedValue(
    new Error("unavailable"),
  );
  let cancelled = false;
  const second = spyOn(t.second.runtime, "read").mockImplementation(
    async () => {
      await t.f.app.db.transaction((r) =>
        r.saveFile({ ...t.file, status: "deleting" }, "ready"),
      );
      return {
        type: "stream",
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
  try {
    await expect(
      t.f.app.files.access(t.file, {}, new AbortController().signal),
    ).rejects.toMatchObject({ status: 404 });
    expect(cancelled).toBe(true);
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("an unavailable instance falls back for dynamic processing and thumbnails", async () => {
  const t = await setup();
  const first = spyOn(t.first.runtime, "read");
  const second = spyOn(t.second.runtime, "read");
  try {
    await t.f.app.plugins.retire(t.first.record.id);
    const processed = await t.f.app.files.access(
      t.file,
      { w: ["10"] },
      new AbortController().signal,
    );
    expect(processed.status).toBe(200);
    expect((await processed.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const thumb = await t.f.app.files.thumbnail(t.file.id);
    expect(thumb.status).toBe(200);
    await thumb.arrayBuffer();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});
