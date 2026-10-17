import { Readable } from "node:stream";
import { test, expect, spyOn } from "bun:test";
import { fixture } from "./helpers";
import type { AccessPlugin } from "../src/plugins/api";

test("parameterless access executes; lazy reads share a source; untouched chains retain redirects", async () => {
  const f = await fixture();
  const uploaded = await (await f.upload()).json();
  const path = new URL(uploaded.url).pathname;
  const replica = (await f.app.db.read((r) => r.replicas(uploaded.id)))[0]!;
  const lease = f.app.plugins.acquire(replica.storage_instance_id, "storage");
  const realRead = lease.runtime.read.bind(lease.runtime);
  let calls = 0,
    load = false;
  const modes: string[] = [];
  const storage = spyOn(lease.runtime, "read").mockImplementation(
    async (input, ctx) => {
      modes.push(input.mode);
      return input.mode === "auto"
        ? { type: "redirect", url: "https://example.com/image.png" }
        : realRead(input, ctx);
    },
  );
  const runtime: AccessPlugin = {
    async check(input) {
      expect("file" in input).toBe(false);
      expect(input.metadata.mimeType).toBe("image/png");
      return { status: "applicable" };
    },
    async process(input, ctx) {
      calls++;
      expect(input.params).toEqual({});
      if (load) {
        const [a, b] = await Promise.all([input.getFile(), input.getFile()]);
        expect(a).toBe(b);
        const bytes = await new Response(await a.openRead()).arrayBuffer();
        expect(bytes.byteLength).toBeGreaterThan(0);
      }
      ctx.data.set("test", true);
      return { status: "pass" };
    },
  };
  f.app.plugins.register({
    id: "test.lazy",
    name: "Lazy",
    kind: "processor",
    version: "1",
    apiVersion: 1,
    stages: {
      access: {
        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance() {
          return runtime;
        },
      },
    },
  });
  try {
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [0, 1].map(() => ({
          pluginId: "test.lazy",
          version: "1",
          config: {},
          onNotApplicable: "abort",
        })),
      },
      access.id,
    );
    for (let i = 0; i < 2; i++)
      expect((await f.request(path)).status).toBe(302);
    expect(calls).toBe(4); // No persistent cache for untouched chains.
    expect(modes).toEqual(["auto", "auto"]);
    modes.length = 0;
    load = true;
    for (let i = 0; i < 2; i++) {
      const response = await f.request(path);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(modes).toEqual(["stream"]); // Read-only results are cached too.
    expect(calls).toBe(6);
    const cached = await f.request(path);
    expect(cached.headers.get("etag")).toBeTruthy();
    expect(cached.headers.get("cache-control")).toContain("public");
    await cached.arrayBuffer();
    runtime.cacheable = false;
    for (let i = 0; i < 2; i++) {
      const fresh = await f.request(path);
      expect(fresh.headers.get("cache-control")).toBe("no-store");
      expect(fresh.headers.has("etag")).toBe(false);
      await fresh.arrayBuffer();
    }
    expect(modes).toEqual(["stream", "stream", "stream"]);
    expect(calls).toBe(10);
  } finally {
    storage.mockRestore();
    await lease.release();
    await f.close();
  }
});

test("later access steps see replacements; parameterless output is cached", async () => {
  const f = await fixture();
  const uploaded = await (await f.upload()).json();
  const path = new URL(uploaded.url).pathname;
  let checks = 0;
  f.app.plugins.register({
    id: "test.inspect",
    name: "Inspect",
    kind: "processor",
    version: "1",
    apiVersion: 1,
    stages: {
      access: {
        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance({ services }) {
          return {
            async check() {
              return { status: "applicable" as const };
            },
            async process(input) {
              checks++;
              const file = await input.getFile();
              const output = await input.createOutput();
              const bytes = await new Response(
                await file.openRead(),
              ).arrayBuffer();
              const image = services.images
                .sharp(Buffer.from(bytes))
                .resize(7, 5)
                .png();
              await output.write(
                Readable.toWeb(image) as unknown as ReadableStream<Uint8Array>,
              );
              return { status: "replace" as const, output };
            },
          };
        },
      },
    },
  });
  f.app.plugins.register({
    id: "test.observe",
    name: "Observe",
    kind: "processor",
    version: "1",
    apiVersion: 1,
    stages: {
      access: {
        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance() {
          return {
            async check(input) {
              expect(input.metadata.width).toBe(7);
              expect((await input.getFile()).metadata.height).toBe(5);
              return { status: "noop" as const };
            },
            async process() {
              throw new Error("Must not process");
            },
          };
        },
      },
    },
  });
  try {
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: ["test.inspect", "test.observe"].map((pluginId) => ({
          pluginId,
          version: "1",
          config: {},
          onNotApplicable: "abort",
        })),
      },
      access.id,
    );
    const first = await f.request(path);
    expect(first.status).toBe(200);
    const bytes = await first.arrayBuffer();
    const second = await f.request(path);
    expect(
      Buffer.from(await second.arrayBuffer()).equals(Buffer.from(bytes)),
    ).toBe(true);
    expect(checks).toBe(1);
  } finally {
    await f.close();
  }
});
