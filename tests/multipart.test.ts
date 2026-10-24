import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import sharp from "sharp";
import { receiveMultipart } from "../src/http/multipart";
import { TemporarySpace } from "../src/infra/temporary-space";
import { settings } from "../src/config";
import { handler } from "../src/http/app";
import { fixture } from "./helpers";

const MiB = 1024 ** 2;
const encode = (value: string) => new TextEncoder().encode(value);
const fileHeader =
  '--test\r\nContent-Disposition: form-data; name="file"; filename="截图.png"\r\nContent-Type: image/png\r\n\r\n';
const end = "\r\n--test--\r\n";
function streamRequest(
  chunks: Uint8Array[],
  options: { length?: number; signal?: AbortSignal } = {},
) {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (index === chunks.length) c.close();
        else c.enqueue(chunks[index++]!);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    request: new Request("http://localhost/api/files", {
      method: "POST",
      body,
      signal: options.signal,
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        ...(options.length === undefined
          ? {}
          : { "content-length": String(options.length) }),
      },
    }),
    get pulls() {
      return index;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "picloom-multipart-"));
  await mkdir(join(root, "temp"));
  const config = settings({
    root,
    encryptionKey: "ab".repeat(32),
    uploadTempBytes: 64 * MiB,
  });
  const space = new TemporarySpace(config);
  return {
    root,
    config,
    space,
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for upload lifecycle");
}

test("multipart streams to disk with backpressure, trailing fields and exact byte limits", async () => {
  const f = await temporary();
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const write = f.space.write.bind(f.space);
  const slow = spyOn(f.space, "write").mockImplementation(
    (path, stream, limit, signal) =>
      write(
        path,
        stream.pipeThrough(
          new TransformStream({
            async transform(chunk, c) {
              await gate;
              c.enqueue(chunk);
            },
          }),
        ),
        limit,
        signal,
      ),
  );
  try {
    const size = 30 * MiB;
    const source = streamRequest([
      encode(fileHeader),
      ...Array.from({ length: size / 65536 }, () => new Uint8Array(65536)),
      encode(
        '\r\n--test\r\nContent-Disposition: form-data; name="profileId"\r\n\r\nchosen\r\n--test--\r\n',
      ),
    ]);
    const result = receiveMultipart(source.request, f.space, size);
    await until(() => slow.mock.calls.length === 1);
    await Bun.sleep(20);
    expect(source.pulls).toBeLessThan(20);
    unblock();
    const received = await result;
    expect(received.name).toBe("截图.png");
    expect(received.fields.profileId).toBe("chosen");
    expect(received.size).toBe(size);
    expect((await stat(received.path)).size).toBe(size);
    expect(f.space.bytes).toBe(size);
    await f.space.remove(received.path);
    slow.mockRestore();
    const over = streamRequest([
      encode(fileHeader),
      new Uint8Array(1025),
      ...Array.from({ length: 20 }, () => new Uint8Array(1024)),
      encode(end),
    ]);
    await expect(
      receiveMultipart(over.request, f.space, 1024),
    ).rejects.toMatchObject({ code: "TOO_LARGE", status: 413 });
    expect(over.cancelled).toBe(true);
    expect(over.pulls).toBeLessThan(22);
    expect(f.space.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
  } finally {
    unblock();
    slow.mockRestore();
    await f.close();
  }
});

test("known lengths reserve before reads; unknown lengths grow only by actual bytes", async () => {
  const f = await temporary();
  try {
    f.config.uploadTempBytes = 512;
    const known = streamRequest(
      [encode(fileHeader), new Uint8Array(256), encode(end)],
      { length: 1024 },
    );
    await expect(
      receiveMultipart(known.request, f.space, MiB),
    ).rejects.toMatchObject({ code: "TEMP_CAPACITY" });
    expect(known.pulls).toBe(0);
    const unknown = streamRequest([
      encode(fileHeader),
      new Uint8Array(256),
      encode(end),
    ]);
    const received = await receiveMultipart(unknown.request, f.space, MiB);
    expect(received.size).toBe(256);
    await f.space.remove(received.path);
    const full = streamRequest([
      encode(fileHeader),
      new Uint8Array(513),
      encode(end),
    ]);
    await expect(
      receiveMultipart(full.request, f.space, MiB),
    ).rejects.toMatchObject({ code: "TEMP_CAPACITY" });
    expect(f.space.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("multipart rejects invalid fields and damaged bodies without keeping temporary files", async () => {
  const f = await temporary();
  try {
    const field = (name: string, value: string) =>
      `--test\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const cases: [string, string][] = [
      [field("file", "text") + "--test--\r\n", "INVALID_INPUT"],
      [field("profileId", "a") + "--test--\r\n", "INVALID_INPUT"],
      [
        field("profileId", "a") +
          field("profileId", "b") +
          fileHeader +
          "abc" +
          end,
        "INVALID_INPUT",
      ],
      [
        field("params", "{}") +
          field("params", "{}") +
          fileHeader +
          "abc" +
          end,
        "INVALID_PARAMS",
      ],
      [fileHeader + "abc\r\n" + fileHeader + "abc" + end, "INVALID_INPUT"],
      [fileHeader + "abc", "INVALID_INPUT"],
      [
        fileHeader +
          'abc\r\n--test\r\nContent-Disposition: form-data; name="params"\r\n\r\n{}',
        "INVALID_INPUT",
      ],
      [
        field("organization", "x".repeat(65537)) + fileHeader + "abc" + end,
        "TOO_LARGE",
      ],
    ];
    for (const [body, code] of cases) {
      // Small chunks also split boundaries, UTF-8 names and headers.
      const data = encode(body);
      const chunks = Array.from(
        { length: Math.ceil(data.length / 37) },
        (_, n) => data.slice(n * 37, (n + 1) * 37),
      );
      await expect(
        receiveMultipart(streamRequest(chunks).request, f.space, MiB),
      ).rejects.toMatchObject({ code });
      expect(f.space.bytes).toBe(0);
      expect(await readdir(join(f.root, "temp"))).toEqual([]);
    }
    const valid =
      field("profileId", "chosen") +
      field("ignored", "ok") +
      fileHeader +
      "abc" +
      end;
    const received = await receiveMultipart(
      streamRequest([encode(valid)]).request,
      f.space,
      3,
    );
    expect(received.fields).toEqual({ profileId: "chosen" });
    expect(received.size).toBe(3);
    await f.space.remove(received.path);
  } finally {
    await f.close();
  }
});

test.each(["open", "write"] as const)(
  "%s ENOSPC remains the failure reason after stream cancellation",
  async (stage) => {
    const f = await temporary();
    const error = Object.assign(new Error("Test disk full"), {
      code: "ENOSPC",
    });
    const open = fs.open;
    let writeSpy: ReturnType<typeof spyOn> | undefined;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!String(args[0]).startsWith(join(f.root, "temp") + "/"))
        return open(...args);
      if (stage === "open") throw error;
      const file = await open(...args);
      writeSpy = spyOn(file, "write").mockRejectedValue(error);
      return file;
    });
    try {
      const source = streamRequest([
        encode(fileHeader),
        ...Array.from({ length: 100 }, () => new Uint8Array(65536)),
        encode(end),
      ]);
      await expect(
        receiveMultipart(source.request, f.space, 10 * MiB),
      ).rejects.toBe(error);
      expect(source.cancelled).toBe(true);
      expect(source.pulls).toBeLessThan(102);
      expect(f.space.bytes).toBe(0);
      expect(await readdir(join(f.root, "temp"))).toEqual([]);
    } finally {
      writeSpy?.mockRestore();
      openSpy.mockRestore();
      await f.close();
    }
  },
);

test("disk errors stop receiving and leave no allocation", async () => {
  const f = await temporary();
  try {
    // A directory at the generated file path makes opening the output fail.
    const blocked = join(f.root, "temp", "blocked");
    await mkdir(blocked);
    const create = spyOn(f.space, "create").mockImplementation(() => {
      f.space.reserve(blocked, 0);
      return blocked;
    });
    const source = streamRequest([
      encode(fileHeader),
      ...Array.from({ length: 100 }, () => new Uint8Array(65536)),
      encode(end),
    ]);
    try {
      await expect(
        receiveMultipart(source.request, f.space, 10 * MiB),
      ).rejects.toBeDefined();
    } finally {
      create.mockRestore();
    }
    expect(source.cancelled).toBe(true);
    // Removal of the injected directory fails too: accounting remains until retry.
    await rm(blocked, { recursive: true });
    await f.space.clean();
    expect(f.space.bytes).toBe(0);
  } finally {
    await f.close();
  }
});

test("valid images above 20 MiB use the configured limit and core cleans failed handoffs", async () => {
  const f = await fixture();
  try {
    const image = await sharp({
      create: { width: 2800, height: 2800, channels: 3, background: "red" },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(image.length).toBeGreaterThan(20 * MiB);
    f.app.config.maxUploadBytes = image.length;
    const serve = handler(f.app);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => serve(req),
    });
    try {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(image)], "大图.png"));
      const response = await fetch(new URL("/api/files", server.url), {
        method: "POST",
        body: form,
        headers: { cookie: f.cookie, "x-csrf-token": f.csrf },
      });
      expect(response.status).toBe(201);
      await response.json();
    } finally {
      await server.stop(true);
    }
    await f.app.files.sweep();
    f.app.config.maxUploadBytes = image.length - 1;
    expect((await f.upload(undefined, image)).status).toBe(413);
    f.app.config.maxUploadBytes = image.length;
    const p = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    await f.app.db.transaction((r) =>
      r.saveProfile(
        {
          ...p,
          max_upload_bytes: f.png.length - 1,
          config_version: p.config_version + 1,
        },
        p.config_version,
      ),
    );
    expect((await f.upload()).status).toBe(413);
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
    const profile = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    await f.app.db.transaction((r) =>
      r.saveProfile(
        {
          ...profile,
          max_upload_bytes: null,
          config_version: profile.config_version + 1,
        },
        profile.config_version,
      ),
    );
    // This passes reception and profile checks, then fails inside core identification.
    expect((await f.upload(undefined, encode("not an image"))).status).not.toBe(
      201,
    );
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("real HTTP disconnect cancels receiving, cleans disk and releases the upload slot", async () => {
  const f = await fixture();
  const serve = handler(f.app);
  f.app.config.uploadConcurrency = 1;
  let finished = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      try {
        return await serve(req);
      } finally {
        finished = true;
      }
    },
  });
  const socket = connect(server.port!, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      `POST /api/files HTTP/1.1\r\nHost: localhost\r\nCookie: ${f.cookie}\r\nX-CSRF-Token: ${f.csrf}\r\nContent-Type: multipart/form-data; boundary=test\r\nContent-Length: ${2 * MiB}\r\n\r\n`,
    );
    socket.write(encode(fileHeader));
    socket.write(new Uint8Array(65536));
    await until(async () => {
      const entries = await readdir(join(f.root, "temp"));
      return (
        entries.length > 0 &&
        (await stat(join(f.root, "temp", entries[0]!))).size > 0
      );
    });
    socket.destroy();
    await until(() => finished);
    expect(f.app.files.temporary.bytes).toBe(0);
    expect(await readdir(join(f.root, "temp"))).toEqual([]);
    expect(await f.app.db.read((r) => r.files(10, 0))).toEqual([]);
    expect((await f.upload()).status).toBe(201);
  } finally {
    socket.destroy();
    await server.stop(true);
    await f.close();
  }
});

test("startup recovery deletes unfinished reception but retains a pending task source", async () => {
  const f = await fixture();
  try {
    // Use a built-in post-save step; defer it so this test makes no external call.
    const pipeline = await f.app.configuration.savePipeline({
      name: "Deferred notification",
      kind: "post_save",
      steps: [
        {
          pluginId: "builtin.telegram-notification",
          version: "1.0.0",
          config: {
            chatId: "0",
            statuses: ["block"],
            includeDetails: false,
            timeoutMs: 100,
          },
          secretEdits: {
            "/botToken": { action: "replace", value: "test-placeholder" },
          },
        },
      ],
    });
    const editor = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...editor,
        postSavePipelineId: pipeline.id,
        expectedVersion: editor.configVersion,
      },
      editor.id,
    );
    const response = await f.upload();
    expect(response.status).toBe(201);
    const { id } = await response.json();
    await f.app.files.tasks.pause();
    await f.app.files.tasks.drain();
    // Seed the durable state of a deferred task after all initial work has stopped.
    const file = (await f.app.db.read((r) => r.file(id)))!;
    const task = (await f.app.db.read((r) => r.tasks(id))).find(
      (t) => t.kind === "action",
    )!;
    const keptName = crypto.randomUUID();
    const kept = join(f.root, "temp", keptName);
    await Bun.write(kept, f.png);
    await f.app.db.transaction(async (r) => {
      await r.saveFile({ ...file, temp_path: keptName }, file.status);
      await r.saveTask({
        ...task,
        status: "pending",
        attempts: 0,
        next_run_at: Date.now() + 86400_000,
      });
    });
    const unfinished = f.app.files.temporary.create();
    await f.app.files.temporary.write(
      unfinished,
      new Blob(["partial upload"]).stream(),
      1024,
    );
    await f.restart();
    expect(await Bun.file(unfinished).exists()).toBe(false);
    expect(await Bun.file(kept).exists()).toBe(true);
    expect(f.app.files.temporary.bytes).toBe(f.png.length);
    expect((await f.app.db.read((r) => r.task(task.id)))!.status).toBe(
      "pending",
    );
  } finally {
    await f.close();
  }
});
