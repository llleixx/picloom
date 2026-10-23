import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { entity } from "../src/persistence/port";
import { handler } from "../src/http/app";

async function setup() {
  const f = await fixture();
  const uploaded = await (await f.upload()).json();
  await f.app.files.sweep();
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
    });
  });
  await f.app.plugins.activate(copy.id);
  f.app.files.random = () => 0;
  const first = f.app.plugins.acquire(original.id, "storage");
  const second = f.app.plugins.acquire(copy.id, "storage");
  return {
    f,
    file,
    path: new URL(uploaded.url).pathname,
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

test.each(["deleted", "blocked"] as const)(
  "%s after initial lookup returns 404 before reading storage with an empty pipeline",
  async (status) => {
    const t = await setup();
    const first = spyOn(t.first.runtime, "read").mockRejectedValue(
      new Error("offline"),
    );
    const second = spyOn(t.second.runtime, "read").mockRejectedValue(
      new Error("offline"),
    );
    let lookup: ReturnType<typeof spyOn> | undefined;
    try {
      const pipeline = (await t.f.app.configuration.pipelines()).find(
        (p) => p.kind === "access",
      )!;
      await t.f.app.configuration.savePipeline(
        { ...pipeline, steps: [], expectedVersion: pipeline.configVersion },
        pipeline.id,
      );
      const read = t.f.app.db.read.bind(t.f.app.db);
      // Let the lookup commit, then change state before access registers inFlight.
      lookup = spyOn(t.f.app.db, "read").mockImplementationOnce(async (fn) => {
        const result = await read(fn);
        if (status === "deleted") {
          await t.f.app.files.delete(t.file.id);
          await t.f.app.files.sweep();
        } else {
          await t.f.app.db.transaction((r) =>
            r.saveFile({ ...t.file, status: "blocked" }, "ready"),
          );
        }
        return result;
      });
      const response = await t.f.request(t.path);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
      expect((await read((r) => r.file(t.file.id)))?.status).toBe(status);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
    } finally {
      lookup?.mockRestore();
      first.mockRestore();
      second.mockRestore();
      await t.close();
    }
  },
);

test("HEAD and conditional originals still require a readable replica", async () => {
  const t = await setup();
  try {
    const initial = await t.f.request(t.path);
    const etag = initial.headers.get("etag")!;
    await initial.arrayBuffer();
    const first = spyOn(t.first.runtime, "read").mockRejectedValue(
      new Error("offline"),
    );
    const second = spyOn(t.second.runtime, "read").mockRejectedValue(
      new Error("offline"),
    );
    try {
      const head = await t.f.request(t.path, "HEAD");
      expect(head.status).toBe(503);
      expect(head.body).toBeNull();
      const conditional = await handler(t.f.app)(
        new Request("http://localhost" + t.path, {
          headers: { "if-none-match": etag },
        }),
      );
      expect(conditional.status).toBe(503);
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
    } finally {
      first.mockRestore();
      second.mockRestore();
    }
  } finally {
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

test.each(["deleting", "blocked"] as const)(
  "%s during fallback prevents publication and cancels the selected stream",
  async (status) => {
    const t = await setup();
    const first = spyOn(t.first.runtime, "read").mockRejectedValue(
      new Error("unavailable"),
    );
    let cancelled = false;
    const second = spyOn(t.second.runtime, "read").mockImplementation(
      async () => {
        await t.f.app.db.transaction((r) =>
          r.saveFile({ ...t.file, status }, "ready"),
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
  },
);

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

test.each(["interrupted", "truncated"])(
  "derived images retry another replica after an %s download",
  async (failure) => {
    const t = await setup();
    const first = spyOn(t.first.runtime, "read").mockImplementation(
      async () => {
        let sent = false;
        return {
          type: "stream",
          stream: new ReadableStream<Uint8Array>(
            {
              pull(c) {
                if (!sent) {
                  sent = true;
                  c.enqueue(new Uint8Array([1]));
                } else if (failure === "truncated") c.close();
                else
                  c.error(new DOMException("Source timed out", "TimeoutError"));
              },
            },
            { highWaterMark: 0 },
          ),
        };
      },
    );
    const second = spyOn(t.second.runtime, "read");
    try {
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
      expect(first).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenCalledTimes(2);
      expect(t.f.app.files.temporary.bytes).toBe(0);
    } finally {
      first.mockRestore();
      second.mockRestore();
      await t.close();
    }
  },
);

test("local download write failures do not retry another replica", async () => {
  const t = await setup();
  const second = spyOn(t.second.runtime, "read");
  const write = spyOn(t.f.app.files.temporary, "write").mockRejectedValue(
    new Error("local disk full"),
  );
  try {
    await expect(t.f.app.files.thumbnail(t.file.id)).rejects.toThrow(
      "local disk full",
    );
    expect(second).not.toHaveBeenCalled();
    expect(t.f.app.files.temporary.bytes).toBe(0);
  } finally {
    write.mockRestore();
    second.mockRestore();
    await t.close();
  }
});

test("reads follow the group's priority or weighted selection strategy", async () => {
  const t = await setup();
  const first = spyOn(t.first.runtime, "read");
  const second = spyOn(t.second.runtime, "read");
  try {
    let group = await t.f.app.configuration.group(t.file.storage_group_id!);
    group = await t.f.app.configuration.saveGroup(
      {
        ...group,
        selectionStrategy: "priority",
        members: [
          { instanceId: t.first.record.id, weight: 1 },
          { instanceId: t.second.record.id, weight: 9 },
        ],
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    t.f.app.files.random = () => 0.5;
    await (
      await t.f.app.files.preview(t.file.id, new AbortController().signal)
    ).arrayBuffer();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await t.f.app.configuration.saveGroup(
      {
        ...group,
        selectionStrategy: "weighted_random",
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    await (
      await t.f.app.files.preview(t.file.id, new AbortController().signal)
    ).arrayBuffer();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  } finally {
    first.mockRestore();
    second.mockRestore();
    await t.close();
  }
});
