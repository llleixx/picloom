import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { demoPackage, zip, demoCode } from "./package-fixtures";
import { archiveFiles } from "../src/plugins/archive";
import { handler } from "../src/http/app";
const context = () => ({
  requestId: "test",
  signal: AbortSignal.timeout(30000),
  log() {},
});
async function inspect(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes = demoPackage(),
) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "plugin.zip"));
  const response = await f.request("/api/plugins/inspect", "POST", form);
  expect(response.status).toBe(200);
  return response.json();
}
test("package inspection does not execute code; confirmation installs, restart loads, references and builtins prevent uninstall", async () => {
  const f = await fixture();
  try {
    const unauthenticated = await handler(f.app)(
      new Request("http://localhost/api/plugins/install", {
        method: "POST",
        headers: { cookie: f.cookie, "content-type": "application/json" },
        body: JSON.stringify({ ticket: "none", confirmTrusted: true }),
      }),
    );
    expect(unauthenticated.status).toBe(403);
    const marker = f.root.replaceAll("\\", "/") + "/executed";
    const prepared = await inspect(
      f,
      demoPackage(
        `await Bun.write(${JSON.stringify(marker)},'executed');\n` + demoCode,
      ),
    );
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(
      (
        await f.request("/api/plugins/install", "POST", {
          ticket: prepared.ticket,
        })
      ).status,
    ).toBe(400);
    const installed = await f.request("/api/plugins/install", "POST", {
      ticket: prepared.ticket,
      confirmTrusted: true,
    });
    expect(installed.status).toBe(201);
    expect((await installed.json()).source).toBe("external");
    expect(await Bun.file(marker).exists()).toBe(true);
    const url = "/api/plugins/example.date/versions/1.0.0";
    const instance = await f.app.plugins.save({
      pluginId: "example.date",
      version: "1.0.0",
      name: "Example instance",
      config: {},
    });
    const owner = await f.app.configuration.profile(f.profileId);
    await f.app.configuration.saveProfile(
      {
        ...owner,
        pathInstanceId: instance.id,
        expectedVersion: owner.configVersion,
      },
      owner.id,
    );
    const blocked = await f.request(url, "DELETE");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.message).toContain("Example instance");
    const lease = f.app.plugins.acquire(instance.id, "path");
    await expect(f.app.plugins.remove(instance.id)).rejects.toThrow();
    await lease.release();
    await f.restart();
    expect(
      (await f.app.packages.list()).find((p) => p.id === "example.date")
        ?.status,
    ).toBe("loaded");
    expect(
      (await f.request("/api/plugins/builtin.local/versions/1.0.0", "DELETE"))
        .status,
    ).toBe(409);
    expect(
      (await f.app.packages.list())
        .filter((p) => p.source === "builtin")
        .every((p) => !p.canUninstall),
    ).toBe(true);
    const duplicateForm = new FormData();
    duplicateForm.set(
      "file",
      new File([new Uint8Array(demoPackage())], "duplicate.zip"),
    );
    expect(
      (await f.request("/api/plugins/inspect", "POST", duplicateForm)).status,
    ).toBe(409);
    await f.app.configuration.deleteProfile(owner.id);
    expect(await f.app.db.read((r) => r.instance(instance.id))).toBeNull();
    expect((await f.request(url, "DELETE")).status).toBe(200);
    expect(
      (await f.app.packages.list()).some((p) => p.id === "example.date"),
    ).toBe(false);
    await f.restart();
    expect(
      (await f.app.packages.list()).some((p) => p.id === "example.date"),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test("failed packages are visible, retryable and removable; cancelled staging never loads; upload tokens cannot install", async () => {
  const f = await fixture();
  try {
    const prepared = await inspect(
      f,
      demoPackage("throw new Error('secret disk path');"),
    );
    const result = await (
      await f.request("/api/plugins/install", "POST", {
        ticket: prepared.ticket,
        confirmTrusted: true,
      })
    ).json();
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain("secret");
    await f.restart();
    expect(
      (await f.app.packages.list()).find((p) => p.id === "example.date")
        ?.status,
    ).toBe("failed");
    expect(
      (
        await (
          await f.request(
            "/api/plugins/example.date/versions/1.0.0/reload",
            "POST",
          )
        ).json()
      ).status,
    ).toBe("failed");
    expect(
      (await f.request("/api/plugins/example.date/versions/1.0.0", "DELETE"))
        .status,
    ).toBe(200);
    const staged = await inspect(f);
    expect(
      (await f.request("/api/plugins/staged/" + staged.ticket, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (
        await f.request("/api/plugins/install", "POST", {
          ticket: staged.ticket,
          confirmTrusted: true,
        })
      ).status,
    ).toBe(404);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "Upload" })
    ).json();
    expect(
      (await f.request("/api/plugin-packages", "GET", undefined, token.token))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request(
          "/api/plugins/install",
          "POST",
          { ticket: "none", confirmTrusted: true },
          token.token,
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
test("ZIP extraction rejects traversal, symlinks, duplicates, corrupt data and expansion limits", () => {
  expect(() => archiveFiles(zip({ "../outside": "oops" }))).toThrow();
  expect(() => archiveFiles(zip({ "/absolute": "oops" }))).toThrow();
  expect(() => archiveFiles(zip({ CON: "oops" }))).toThrow();
  expect(() =>
    archiveFiles(zip({ link: "target" }, { mode: 0xa1ff })),
  ).toThrow();
  expect(() => archiveFiles(zip({ A: "one", a: "two" }))).toThrow();
  const corrupt = zip({ "index.js": "abc" });
  corrupt[38] = corrupt[38]! ^ 1;
  expect(() => archiveFiles(corrupt)).toThrow();
  expect(() =>
    archiveFiles(
      zip({ large: "x".repeat(51 * 1024 * 1024) }, { deflate: true }),
    ),
  ).toThrow();
  expect(archiveFiles(demoPackage()).has("plugin.json")).toBe(true);
});
