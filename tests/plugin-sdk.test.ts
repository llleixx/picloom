import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { fixture } from "./helpers";
import { externalBuiltin, bundledPackage } from "./package-fixtures";
import { PluginError, isPluginError } from "../plugin-sdk";
import { assertLocalDirectory } from "../src/plugins/local-directory";
import { localStorage } from "../src/builtins/storage/local/index";

async function install(f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "plugin.zip"));
  const inspected = await f.request("/api/plugins/inspect", "POST", form);
  expect(inspected.status).toBe(200);
  const installed = await f.request("/api/plugins/install", "POST", {
    ticket: (await inspected.json()).ticket,
    confirmTrusted: true,
  });
  expect(installed.status).toBe(201);
  expect((await installed.json()).source).toBe("external");
}

test("bundled local and Sharp plugins install and run without application imports", async () => {
  const f = await fixture();
  try {
    await install(
      f,
      await externalBuiltin(
        "local",
        "localStorage",
        "external.local",
        "storage",
      ),
    );
    await install(
      f,
      await externalBuiltin(
        "sharp",
        "sharpProcessor",
        "external.sharp",
        "processor",
      ),
    );
    const local = await f.app.plugins.save({
      pluginId: "external.local",
      version: "1.0.0",
      name: "External local",
      config: { root: join(f.root, "external") },
    });
    const profile = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    await f.app.db.transaction((r) =>
      r.replaceMembers(profile.storage_group_id, [
        { instanceId: local.id, weight: 1 },
      ]),
    );
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            pluginId: "external.sharp",
            version: "1.0.0",
            config: {},
            enabledParams: ["w"],
            onNotApplicable: "abort",
          },
        ],
      },
      access.id,
    );
    const uploaded = await f.upload();
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json();
    const path = new URL(file.url).pathname;
    const original = await f.request(path);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(
      Buffer.from(f.png),
    );
    const processed = await f.request(path + "?w=12");
    expect(processed.status).toBe(200);
    expect(
      (await sharp(Buffer.from(await processed.arrayBuffer())).metadata())
        .width,
    ).toBe(12);
    let status = await (await f.request("/api/system/status")).json();
    for (let i = 0; i < 100 && status.local.calculating; i++) {
      await Bun.sleep(10);
      status = await (await f.request("/api/system/status")).json();
    }
    expect(status.local.originals).toBeGreaterThanOrEqual(f.png.length);
    await f.restart();
    expect(f.app.plugins.isReady(local.id)).toBe(true);
    const read = await f.request(path);
    expect(read.status).toBe(200);
    await read.arrayBuffer();
    const lease = f.app.plugins.acquire(local.id, "storage");
    try {
      const ctx = {
        requestId: "external",
        signal: AbortSignal.timeout(5000),
        log() {},
      };
      const key = "standalone.png";
      const written = await lease.runtime.write(
        {
          operationId: "external-write",
          fileId: crypto.randomUUID(),
          storageKey: key,
          file: {
            metadata: {
              mimeType: "image/png",
              byteSize: f.png.length,
              width: 40,
              height: 20,
            },
            async openRead() {
              return new Blob([new Uint8Array(f.png)]).stream();
            },
          },
        },
        ctx,
      );
      await lease.runtime.delete(
        {
          operationId: "external-delete",
          storageKey: key,
          locator: written.locator ?? null,
        },
        ctx,
      );
      expect(await Bun.file(join(f.root, "external", key)).exists()).toBe(
        false,
      );
    } finally {
      await lease.release();
    }
  } finally {
    await f.close();
  }
});

test("an independently bundled SDK error preserves retry and write outcome", async () => {
  const f = await fixture();
  try {
    const sdk = new URL("../plugin-sdk/index.ts", import.meta.url).pathname;
    await install(
      f,
      await bundledPackage(
        "external.errors",
        "path",
        `import { PluginError } from ${JSON.stringify(sdk)}; export default {id:"external.errors",name:"external.errors",kind:"path",version:"1.0.0",apiVersion:1,configSchemaVersion:1,configSchema:{type:"object",properties:{}},async createInstance(){return {async generate(){throw new PluginError("INVALID_INPUT","External failure",false,"notApplied")}}}};`,
      ),
    );
    const instance = await f.app.plugins.save({
      pluginId: "external.errors",
      version: "1.0.0",
      name: "Error",
      config: {},
    });
    const lease = f.app.plugins.acquire(instance.id, "path");
    try {
      let caught: unknown;
      try {
        await lease.runtime.generate(
          {
            fileId: "x",
            uploadedAt: 0,
            metadata: {
              mimeType: null,
              byteSize: null,
              width: null,
              height: null,
            },
          },
          { requestId: "test", signal: AbortSignal.timeout(5000), log() {} },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught instanceof PluginError).toBe(false);
      expect(isPluginError(caught)).toBe(true);
      if (isPluginError(caught)) {
        expect(caught.retryable).toBe(false);
        expect(caught.outcome).toBe("notApplied");
      }
    } finally {
      await lease.release();
    }
    const profile = await f.app.configuration.profile(f.profileId);
    await f.app.configuration.saveProfile(
      {
        ...profile,
        pathInstanceId: instance.id,
        expectedVersion: profile.configVersion,
      },
      profile.id,
    );
    const response = await f.upload();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("PLUGIN_INVALID_INPUT");
    expect(JSON.stringify(body)).not.toContain("External failure");
  } finally {
    await f.close();
  }
});

test("SDK and builtins stay within the public dependency boundary; directory declarations are validated", async () => {
  for (const folder of ["plugin-sdk", "src/builtins"]) {
    const root = new URL("../" + folder + "/", import.meta.url);
    for (const name of await readdir(root, { recursive: true })) {
      if (!name.endsWith(".ts")) continue;
      const source = await readFile(new URL(name, root), "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|import\s*\()["'](\.[^"']+)["']/g,
      )) {
        const target = new URL(match[1]!, new URL(name, root)).pathname;
        expect(
          target.includes("/plugin-sdk") ||
            (folder === "src/builtins" && target.includes("/src/builtins/")),
        ).toBe(true);
      }
    }
  }
  expect(() => assertLocalDirectory(localStorage)).not.toThrow();
  expect(() =>
    assertLocalDirectory({
      ...localStorage,
      localDirectory: { configPath: "/missing" },
    }),
  ).toThrow();
  expect(() =>
    assertLocalDirectory({
      ...localStorage,
      configSchema: {
        type: "object",
        properties: { root: { type: "string" } },
      },
    }),
  ).toThrow();
});
