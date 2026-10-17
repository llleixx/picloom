import { test, expect } from "bun:test";
import { publicImageAddress, downloadImage } from "../src/infra/remote-image";
import { fixture } from "./helpers";
test("remote image download rejects local, reserved and mapped addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    expect(publicImageAddress(address)).toBe(false);
  expect(publicImageAddress("8.8.8.8")).toBe(true);
  expect(publicImageAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of [
    "http://127.1/image.png",
    "http://[::1]/x",
    "file:///etc/passwd",
    "https://user:secret@example.com/x",
  ])
    await expect(
      downloadImage(url, 1024, new AbortController().signal, async () => {}),
    ).rejects.toThrow();
});
test("URL uploads authorize before downloading and reject local URLs", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: f.profileId,
          url: "http://127.0.0.1/a.png",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: "missing",
          url: "https://example.com/a.png",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: f.profileId,
          url: 42,
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
test("remote download streams into managed storage and enforces size during transfer", async () => {
  const { spyOn } = await import("bun:test");
  const http = await import("node:http");
  const { Readable } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  const f = await fixture();
  let destroyed = false;
  let consumedBeforeEnd = false;
  let consumed = false;
  const requestSpy = spyOn(http, "request").mockImplementation(((
    options: any,
    callback: any,
  ) => {
    expect(options.hostname).toBe("93.184.216.34");
    const incoming = Readable.from(
      (async function* () {
        yield Buffer.from(f.png);
        for (let n = 0; n < 100 && !consumed; n++) await Bun.sleep(1);
        consumedBeforeEnd = consumed;
        yield Buffer.from(f.png);
      })(),
    ) as any;
    incoming.statusCode = 200;
    incoming.headers = {};
    incoming.on("close", () => {
      destroyed = true;
    });
    const outgoing = new EventEmitter() as any;
    outgoing.end = () => callback(incoming);
    return outgoing;
  }) as any);
  try {
    const path = f.app.files.temporary.create(f.png.length * 2);
    const name = await downloadImage(
      "http://93.184.216.34/image.png",
      f.png.length * 2,
      new AbortController().signal,
      async (stream, name, signal) => {
        await f.app.files.temporary.write(
          path,
          stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                consumed = true;
                controller.enqueue(chunk);
              },
            }),
          ),
          f.png.length * 2,
          signal,
        );
        return name;
      },
    );
    expect(name).toBe("image.png");
    expect(consumedBeforeEnd).toBe(true);
    expect(await Bun.file(path).size).toBe(f.png.length * 2);
    await f.app.files.temporary.remove(path);
    expect(destroyed).toBe(true);
    const small = f.app.files.temporary.create(f.png.length);
    await expect(
      downloadImage(
        "http://93.184.216.34/image.png",
        f.png.length,
        new AbortController().signal,
        async (stream, _name, signal) =>
          f.app.files.temporary.write(small, stream, f.png.length, signal),
      ),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(f.app.files.temporary.bytes).toBe(0);
  } finally {
    requestSpy.mockRestore();
    await f.close();
  }
});
