import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { settings } from "../src/config";

test("separate image origin, HEAD and ETag preserve public paths and deletion", async () => {
  const f = await fixture();
  try {
    f.app.config.imageOrigin = "https://images.example.com";
    f.app.config.imageCacheMaxAge = 120;
    const uploaded = await (await f.upload()).json();
    expect(uploaded.url).toStartWith("https://images.example.com/i/");
    expect(
      (await (await f.request("/api/files/" + uploaded.id)).json()).url,
    ).toBe(uploaded.url);
    const path = new URL(uploaded.url).pathname;
    const handle = handler(f.app);
    const get = await f.request(path);
    const etag = get.headers.get("etag")!;
    expect(etag).toStartWith('W/"original-');
    expect(get.headers.get("cache-control")).toBe(
      "public, max-age=120, must-revalidate",
    );
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(
      new Uint8Array(f.png),
    );
    const head = await f.request(path, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    expect(Number(head.headers.get("content-length"))).toBe(f.png.length);
    expect(await head.text()).toBe("");
    const conditional = () =>
      handle(
        new Request("http://localhost" + path, {
          headers: { "if-none-match": '"other", ' + etag },
        }),
      );
    const fresh = await conditional();
    expect(fresh.status).toBe(304);
    expect(fresh.body).toBeNull();
    await f.request("/api/files/" + uploaded.id, "DELETE");
    expect((await conditional()).status).toBe(404);
    await f.app.files.sweep();
    expect((await f.app.db.read((r) => r.file(uploaded.id)))!.status).toBe(
      "deleted",
    );
  } finally {
    await f.close();
  }
});

test("processed validators follow the cache generation and pipeline configuration", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    const path = new URL(uploaded.url).pathname;
    const handle = handler(f.app);
    const first = await f.request(path + "?w=8&format=webp");
    const etag = first.headers.get("etag")!;
    expect(etag).toStartWith('W/"processed-');
    await first.arrayBuffer();
    const conditional = () =>
      handle(
        new Request("http://localhost" + path + "?format=webp&w=8", {
          headers: { "if-none-match": etag },
        }),
      );
    expect((await conditional()).status).toBe(304);
    const head = await f.request(path + "?w=8&format=webp", "HEAD");
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.body).toBeNull();
    await f.app.files.cache.remove(uploaded.id);
    const regenerated = await conditional();
    expect(regenerated.status).toBe(200);
    expect(regenerated.headers.get("etag")).not.toBe(etag);
    await regenerated.arrayBuffer();
    const pipeline = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    pipeline.steps[0]!.config.allowEnlargement = true;
    await f.app.configuration.savePipeline(
      { ...pipeline, expectedVersion: pipeline.configVersion },
      pipeline.id,
    );
    const changed = await conditional();
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    await changed.arrayBuffer();
  } finally {
    await f.close();
  }
});

test("hotlink rules apply before original, transform and conditional responses", async () => {
  const f = await fixture();
  try {
    f.app.config.hotlinkEnabled = true;
    f.app.config.imageCacheMaxAge = 600;
    f.app.config.hotlinkAllowEmpty = false;
    f.app.config.hotlinkAllowedHosts = [
      "blog.example.com",
      "*.docs.example.com",
    ];
    const uploaded = await (await f.upload()).json();
    const path = new URL(uploaded.url).pathname;
    const handle = handler(f.app);
    async function read(referer?: string, suffix = "", conditional?: string) {
      const headers = new Headers();
      if (referer !== undefined) headers.set("referer", referer);
      if (conditional) headers.set("if-none-match", conditional);
      const response = await handle(
        new Request("http://localhost" + path + suffix, { headers }),
      );
      await response.arrayBuffer();
      return response;
    }
    for (const referer of [
      undefined,
      "not-a-url",
      "https://blog.example.com.evil.test/",
      "https://docs.example.com/",
    ])
      expect((await read(referer)).status).toBe(403);
    for (const referer of [
      "http://localhost/app/images",
      "https://blog.example.com/post",
      "https://a.docs.example.com/",
    ])
      expect((await read(referer)).status).toBe(200);
    const allowed = await read("https://blog.example.com/");
    expect(allowed.headers.get("cache-control")).toBe(
      "public, max-age=600, must-revalidate",
    );
    expect(allowed.headers.get("vary")).toBeNull();
    expect(
      (await read("https://evil.test/", "", allowed.headers.get("etag")!))
        .status,
    ).toBe(403);
    expect((await read("https://evil.test/", "?w=8")).status).toBe(403);
    f.app.config.hotlinkAllowEmpty = true;
    expect((await read()).status).toBe(200);
  } finally {
    await f.close();
  }
});

test("token expiration and profile restrictions are validated and persist", async () => {
  const f = await fixture();
  try {
    const expiresAt = Date.now() + 7 * 86400000;
    const created = await f.request("/api/tokens", "POST", {
      name: "Scoped",
      expiresAt,
      profileIds: [f.profileId],
    });
    expect(created.status).toBe(201);
    const token = (await created.json()).token;
    const second = crypto.randomUUID();
    const form = new FormData();
    form.set("profileId", second);
    form.set("file", new File([new Uint8Array(f.png)], "a.png"));
    expect((await f.request("/api/files", "POST", form, token)).status).toBe(
      403,
    );
    expect(await f.app.db.read((r) => r.countFiles())).toBe(0);
    expect((await f.upload(token)).status).toBe(201);
    expect(
      (await f.request("/api/files", "GET", undefined, token)).status,
    ).toBe(403);
    await f.restart();
    expect((await f.upload(token)).status).toBe(201);
    const listed = await (await f.request("/api/tokens")).json();
    expect(listed[0].profileIds).toEqual([f.profileId]);
    expect(listed[0].expiresAt).toBe(expiresAt);
    const permanentResponse = await f.request("/api/tokens", "POST", {
      name: "Permanent",
      expiresAt: null,
      profileIds: [f.profileId],
    });
    expect(permanentResponse.status).toBe(201);
    const permanent = await permanentResponse.json();
    expect(permanent.expiresAt).toBeNull();
    expect((await f.upload(permanent.token)).status).toBe(201);
    await f.request("/api/tokens/" + permanent.id, "DELETE");
    expect((await f.upload(permanent.token)).status).toBe(401);
    for (const extra of [
      { expiresAt: Date.now() - 1 },
      { profileIds: [] },
      { profileIds: ["missing"] },
      { profileIds: [f.profileId, f.profileId] },
    ])
      expect(
        (await f.request("/api/tokens", "POST", { name: "Invalid", ...extra }))
          .status,
      ).toBe(400);
    const retained = await (
      await f.request("/api/tokens", "POST", {
        name: "Keep after password change",
        expiresAt: null,
      })
    ).json();
    await f.request("/api/auth/password", "POST", {
      oldPassword: "test-password-123",
      password: "changed-password-123",
    });
    expect((await f.request("/api/auth/session")).status).toBe(401);
    expect((await f.upload(retained.token)).status).toBe(201);
    expect((await f.upload(token)).status).toBe(201);
    await f.restart();
    expect((await f.upload(retained.token)).status).toBe(201);
  } finally {
    await f.close();
  }
});

test("public image settings validate origin and rule syntax", () => {
  const base = {
    encryptionKey: "ab".repeat(32),
    origin: "https://site.example.com",
  };
  expect(settings(base).imageOrigin).toBe(base.origin);
  expect(settings({ ...base, imageCacheMaxAge: 0 }).imageCacheMaxAge).toBe(0);
  expect(() =>
    settings({ ...base, imageOrigin: "https://images.example.com/path" }),
  ).toThrow();
  expect(() =>
    settings({ ...base, hotlinkAllowedHosts: ["https://example.com"] }),
  ).toThrow();
  expect(() => settings({ ...base, imageCacheMaxAge: -1 })).toThrow();
});

test("SVG responses retain restrictive CSP across GET, HEAD and 304 without rewriting bytes", async () => {
  const f = await fixture();
  try {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><style>rect{fill:red}</style><rect width="20" height="10"/><script>window.svgRan=true</script></svg>',
    );
    const uploaded = await (await f.upload(undefined, svg)).json();
    const path = new URL(uploaded.url).pathname;
    const get = await f.request(path);
    expect(get.status).toBe(200);
    const csp = get.headers.get("content-security-policy");
    expect(csp).toBe(
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(Buffer.from(await get.arrayBuffer())).toEqual(svg);
    const head = await f.request(path, "HEAD");
    expect(head.headers.get("content-security-policy")).toBe(csp);
    expect(head.body).toBeNull();
    const cached = await handler(f.app)(
      new Request("http://localhost" + path, {
        headers: { "if-none-match": get.headers.get("etag")! },
      }),
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("content-security-policy")).toBe(csp);
    const png = await (await f.upload()).json();
    const response = await f.request(new URL(png.url).pathname);
    expect(response.headers.get("content-security-policy")).toBeNull();
    await response.arrayBuffer();
  } finally {
    await f.close();
  }
});

test("redirect caching respects both URL expiration and the configured maximum", async () => {
  const f = await fixture();
  try {
    const uploaded = await (await f.upload()).json();
    const path = new URL(uploaded.url).pathname;
    const replica = (await f.app.db.read((r) => r.replicas(uploaded.id)))[0]!;
    const lease = f.app.plugins.acquire(replica.storage_instance_id, "storage");
    const read = spyOn(lease.runtime, "read");
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      f.app.config.imageCacheMaxAge = 120;
      for (const [remaining, expected] of [
        [60500, 60],
        [500, 0],
        [300000, 120],
        [undefined, 120],
      ] as const) {
        read.mockResolvedValue({
          type: "redirect",
          url: "https://example.com/image.png",
          expiresAt: remaining === undefined ? undefined : now + remaining,
        });
        const response = await f.request(path);
        expect(response.status).toBe(302);
        expect(response.headers.get("cache-control")).toBe(
          `public, max-age=${expected}, must-revalidate`,
        );
      }
      for (const expiresAt of [now, NaN, Infinity]) {
        read.mockResolvedValue({
          type: "redirect",
          url: "https://example.com/image.png",
          expiresAt,
        });
        expect((await f.request(path)).status).toBe(502);
      }
    } finally {
      clock.mockRestore();
      read.mockRestore();
      await lease.release();
    }
  } finally {
    await f.close();
  }
});
