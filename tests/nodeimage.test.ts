import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";

test("NodeImage storage: upload, redirect, processing stream, uncertain writes and honest deletion", async () => {
  const f = await fixture();
  let uploads = 0,
    downloads = 0,
    exists = true,
    lostResponse = false;
  const remoteId = "nodeimage-test-id";
  const url = "https://cdn.nodeimage.com/i/test.png";
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    input,
    init,
  ) => {
    const address = String(input);
    if (address === url) {
      expect(new Headers(init?.headers).has("X-API-Key")).toBe(false);
      downloads++;
      return new Response(new Uint8Array(f.png), {
        headers: {
          "content-type": "image/png",
          "content-length": String(f.png.length),
        },
      });
    }
    expect(new Headers(init?.headers).get("X-API-Key")).toBe("test-key");
    expect(init?.redirect).toBe("error");
    if (address.endsWith("/api/upload")) {
      uploads++;
      if (lostResponse)
        throw new TypeError("network error containing private details");
      const image = (init?.body as FormData).get("image") as File;
      expect(image.type).toBe("image/png");
      expect(Buffer.from(await image.arrayBuffer()).equals(f.png)).toBe(true);
      return Response.json({
        success: true,
        image_id: remoteId,
        links: { direct: url },
      });
    }
    expect(address).toBe("https://api.nodeimage.com/api/image/" + remoteId);
    if (init?.method === "DELETE")
      return new Response("Cannot DELETE /api/image", { status: 404 });
    return exists
      ? Response.json({
          image_id: remoteId,
          size: f.png.length,
          links: { direct: url },
        })
      : Response.json({ error: "Image not found" }, { status: 404 });
  }) as typeof fetch);
  try {
    const response = await f.request("/api/storage-sources", "POST", {
      name: "NodeImage test",
      pluginId: "builtin.nodeimage",
      version: "1.0.0",
      config: {},
      secretEdits: { "/apiKey": { action: "replace", value: "test-key" } },
    });
    expect(response.status).toBe(201);
    const source = await response.json();
    expect(source.ready).toBe(true);
    expect(JSON.stringify(source)).not.toContain("test-key");
    const profile = await f.app.configuration.profile(f.profileId);
    const group = await f.app.configuration.group(profile.storageGroupId);
    await f.app.configuration.saveGroup(
      {
        ...group,
        members: [{ instanceId: source.id, weight: 1 }],
        expectedVersion: group.configVersion,
      },
      group.id,
    );
    const upload = await f.upload();
    expect(upload.status).toBe(201);
    const file = await upload.json();
    const read = await f.request(new URL(file.url).pathname);
    expect(read.status).toBe(302);
    expect(read.headers.get("location")).toBe(url);
    const processed = await f.request(new URL(file.url).pathname + "?w=10");
    expect(processed.status).toBe(200);
    expect((await processed.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(downloads).toBe(1);
    const lease = f.app.plugins.acquire(source.id, "storage");
    const ctx = {
      signal: AbortSignal.timeout(5000),
      requestId: "test",
      log() {},
    };
    try {
      const locator = { imageId: remoteId, url };
      const recovery = {
        operationId: "op",
        fileId: file.id,
        storageKey: "a.png",
        expectedSize: f.png.length,
        locator: null,
      };
      expect(await lease.runtime.recoverWrite!(recovery, ctx)).toEqual({
        status: "unknown",
      });
      expect(
        await lease.runtime.recoverWrite!({ ...recovery, locator }, ctx),
      ).toMatchObject({ status: "stored" });
      expect(
        await lease.runtime.read(
          { storageKey: remoteId, locator: null, mode: "auto" },
          ctx,
        ),
      ).toMatchObject({ type: "redirect", url });
      lostResponse = true;
      await expect(
        lease.runtime.write(
          {
            operationId: "op",
            fileId: "id",
            storageKey: "a.png",
            file: {
              metadata: {
                byteSize: f.png.length,
                mimeType: "image/png",
                width: 40,
                height: 20,
              },
              async openRead() {
                return new Blob([new Uint8Array(f.png)]).stream();
              },
            },
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        code: "NODEIMAGE_UPLOAD",
        outcome: "unknown",
        retryable: false,
      });
      expect(uploads).toBe(2);
    } finally {
      await lease.release();
    }
    expect((await f.request("/api/files/" + file.id, "DELETE")).status).toBe(
      202,
    );
    await f.app.files.sweep();
    const tasks = await f.app.db.read((r) => r.tasks(file.id));
    expect(
      tasks.some(
        (t) =>
          t.status === "failed" &&
          t.last_error?.includes("NODEIMAGE_DELETE_UNAVAILABLE"),
      ),
    ).toBe(true);
    // An HTML 404 from the absent DELETE route must not be interpreted as a deleted image.
    exists = false;
    const cleanup = f.app.plugins.acquire(source.id, "storage");
    try {
      await cleanup.runtime.delete(
        {
          operationId: "cleanup",
          storageKey: "a.png",
          locator: { imageId: remoteId, url },
        },
        ctx,
      );
    } finally {
      await cleanup.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});
