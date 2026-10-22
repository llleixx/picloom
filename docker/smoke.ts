import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// Bun loads the developer's .env; do not let it override the isolated Compose env file.
const composeKeys = new Set([
  "ENCRYPTION_KEY",
  "INITIAL_OWNER_PASSWORD",
  "PUBLIC_ORIGIN",
  "HTTP_PORT",
  "PUBLISH_ADDRESS",
  "POSTGRES_PASSWORD",
  "TRUSTED_PROXIES",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_FILE",
]);
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !composeKeys.has(key)),
);
// Opt-in integration test: real Docker images, isolated Compose projects and bind directories.
async function command(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env: childEnv });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new Error(`${args[0]} ${args[1]} failed (${code}): ${err}`);
  return out.trim();
}
console.log("Building picloom:local");
await command(["docker", "build", "-t", "picloom:local", "."]);
// Verify the allocator is actually loaded and the per-image default is applied.
await command([
  "docker",
  "run",
  "--rm",
  "--entrypoint",
  "bun",
  "picloom:local",
  "-e",
  `const assert = require("node:assert/strict");
   assert.equal(require("sharp/lib/sharp")._isUsingJemalloc(), true);
   assert.equal(require("sharp").concurrency(), 1);`,
]);
for (const backend of ["sqlite", "postgres"]) {
  const project = `picloom-smoke-${backend}-${crypto.randomUUID().slice(0, 8)}`;
  const temp = await mkdtemp(join(tmpdir(), "picloom-docker-"));
  const envFile = join(temp, ".env");
  const overrideFile = join(temp, "compose.test.json");
  await writeFile(
    overrideFile,
    JSON.stringify({
      services: {
        picloom: {
          image: "picloom:local",
          pull_policy: "never",
          volumes: [`${temp}/data:/var/lib/picloom`],
        },
        ...(backend === "postgres"
          ? {
              postgres: {
                volumes: [`${temp}/postgres:/var/lib/postgresql/data`],
              },
            }
          : {}),
      },
    }),
  );
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const password = crypto.randomUUID();
  await writeFile(
    envFile,
    `ENCRYPTION_KEY=${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}
INITIAL_OWNER_PASSWORD=${password}
POSTGRES_PASSWORD=${crypto.randomUUID().replaceAll("-", "")}
PUBLIC_ORIGIN=${origin}
HTTP_PORT=${port}
PUBLISH_ADDRESS=127.0.0.1
`,
    { mode: 0o600 },
  );
  const compose = (...args: string[]) =>
    command([
      "docker",
      "compose",
      "--env-file",
      envFile,
      "-p",
      project,
      "-f",
      `compose.${backend}.yml`,
      "-f",
      overrideFile,
      ...args,
    ]);
  let cookie = "",
    csrf = "";
  async function request(path: string, method = "GET", value?: unknown) {
    const headers = new Headers({ origin });
    if (cookie) headers.set("cookie", cookie);
    if (csrf) headers.set("x-csrf-token", csrf);
    let body: BodyInit | undefined;
    if (value instanceof FormData) body = value;
    else if (value !== undefined) {
      body = JSON.stringify(value);
      headers.set("content-type", "application/json");
    }
    return fetch(origin + path, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
  }
  async function login() {
    const result = await request("/api/auth/login", "POST", {
      username: "admin",
      password,
    });
    assert.equal(result.status, 200, await result.clone().text());
    cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    csrf = (await (await request("/api/auth/session")).json()).csrfToken;
  }
  try {
    console.log(`${backend}: starting isolated deployment`);
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    assert.equal((await request("/")).status, 200);
    assert.equal((await request("/app/images")).status, 200);
    await login();
    // Optional documented initialization command runs with the app stopped.
    await compose("stop", "picloom");
    await compose(
      "run",
      "--rm",
      "--no-deps",
      "picloom",
      "bun",
      "src/cli.ts",
      "init-dev",
    );
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    await login();
    // Fresh production defaults have no access processing; configure it explicitly.
    const access = (await (await request("/api/pipelines")).json()).find(
      (pipeline: { kind: string }) => pipeline.kind === "access",
    );
    const configured = await request(`/api/pipelines/${access.id}`, "PUT", {
      ...access,
      expectedVersion: access.configVersion,
      steps: [
        {
          pluginId: "builtin.sharp",
          version: "1.0.0",
          config: {},
          onNotApplicable: "abort",
          enabledParams: ["w", "h", "fit", "q", "format"],
        },
      ],
    });
    assert.equal(configured.status, 200, await configured.clone().text());
    const profile = (await (await request("/api/upload-profiles")).json())[0];
    assert.ok(profile?.id);
    const png = await sharp({
      create: { width: 320, height: 160, channels: 3, background: "#42b883" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("profileId", profile.id);
    form.set("file", new File([new Uint8Array(png)], "sample.png"));
    const uploaded = await request("/api/files", "POST", form);
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const file = await uploaded.json();
    const path = new URL(file.url).pathname;
    assert.deepEqual(
      Buffer.from(await (await request(path)).arrayBuffer()),
      png,
    );
    const processed = await request(path + "?w=8&format=webp");
    assert.equal(processed.status, 200);
    assert.equal(
      (await sharp(Buffer.from(await processed.arrayBuffer())).metadata())
        .width,
      8,
    );
    const fontPath = await compose(
      "exec",
      "-T",
      "picloom",
      "fc-match",
      "-f",
      "%{file}",
      "sans:lang=zh-cn",
    );
    assert.equal(fontPath, "/usr/local/share/fonts/NotoSansSC-Regular.otf");
    const charset = (
      await compose(
        "exec",
        "-T",
        "picloom",
        "fc-query",
        "-f",
        "%{charset}",
        fontPath,
      )
    ).split(/\s+/);
    const text = "中文水印 Picloom";
    for (const character of text) {
      const code = character.codePointAt(0)!;
      assert.ok(
        charset.some((range) => {
          const [start, end = start] = range
            .split("-")
            .map((value) => parseInt(value, 16));
          return code >= start! && code <= end!;
        }),
        `Missing watermark glyph: ${character}`,
      );
    }
    const marked = await request(`/api/pipelines/${access.id}`, "PUT", {
      ...access,
      expectedVersion: (await configured.json()).configVersion,
      steps: [
        {
          pluginId: "builtin.watermark",
          version: "1.0.0",
          config: {
            font: "sans",
            fontSizePercent: 3,
            marginPercent: 2,
            color: "#ffffff",
            imageWidth: 128,
            widthPercent: 10,
            margin: 16,
            type: "text",
            text,
            sizeMode: "fixed",
            fontSize: 24,
            position: "center",
            opacity: 100,
          },
          onNotApplicable: "abort",
        },
      ],
    });
    assert.equal(marked.status, 200, await marked.clone().text());
    const watermarked = await request(path);
    assert.equal(watermarked.status, 200);
    const pixels = await sharp(Buffer.from(await watermarked.arrayBuffer()))
      .removeAlpha()
      .raw()
      .toBuffer();
    const originalPixels = await sharp(png).removeAlpha().raw().toBuffer();
    assert.equal(pixels.length, originalPixels.length);
    assert.notDeepEqual(
      pixels,
      originalPixels,
      "Chinese watermark must change image pixels",
    );
    const reset = await request(`/api/pipelines/${access.id}`, "PUT", {
      ...access,
      steps: [],
      expectedVersion: (await marked.json()).configVersion,
    });
    assert.equal(reset.status, 200, await reset.clone().text());
    const settings = await (await request("/api/settings")).json();
    assert.equal(
      (
        await request("/api/settings", "PUT", {
          ...settings,
          siteName: "Persistent Picloom",
        })
      ).status,
      200,
    );
    // Recreate containers and their networks, retaining only bind-mounted data.
    await compose("down");
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    await login();
    assert.equal(
      (await (await request("/api/files/" + file.id)).json()).id,
      file.id,
    );
    assert.deepEqual(
      Buffer.from(await (await request(path)).arrayBuffer()),
      png,
    );
    assert.equal(
      (await (await request("/api/settings")).json()).siteName,
      "Persistent Picloom",
    );
    // Abnormal exit leaves service.lock behind; a recreated container may reuse its PID.
    await compose("kill", "-s", "SIGKILL", "picloom");
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "60");
    assert.deepEqual(
      Buffer.from(await (await request(path)).arrayBuffer()),
      png,
    );
    const backup = await request("/api/system/backups", "POST");
    assert.equal(backup.status, backend === "sqlite" ? 201 : 400);
    if (backend === "sqlite") {
      const backups = await (await request("/api/system/backups")).json();
      assert.ok(backups.length > 0);
      await compose("down");
      await compose(
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "180",
      );
      assert.ok(
        (await (await request("/api/system/backups")).json()).length > 0,
      );
      const restored = await fetch(
        origin + `/api/system/backups/${backups[0].id}/restore`,
        {
          method: "POST",
          headers: {
            cookie,
            origin,
            "x-csrf-token": csrf,
            "x-confirm-restore": "restore",
          },
          signal: AbortSignal.timeout(30000),
        },
      );
      assert.equal(restored.status, 200, await restored.clone().text());
      await login();
      assert.deepEqual(
        Buffer.from(await (await request(path)).arrayBuffer()),
        png,
      );
    } else {
      assert.equal((await backup.json()).error.code, "BACKUP_UNSUPPORTED");
    }
    assert.equal(
      (await request("/api/files/" + file.id, "DELETE")).status,
      202,
    );
    for (let i = 0; i < 30; i++) {
      if (
        (await (await request("/api/files/" + file.id)).json()).status ===
        "deleted"
      )
        break;
      await Bun.sleep(500);
    }
    assert.equal(
      (await (await request("/api/files/" + file.id)).json()).status,
      "deleted",
    );
    console.log(
      `${backend}: healthy startup, Owner login, upload, Sharp, Chinese watermark, recreated-container persistence, SIGKILL recovery, backups policy and deletion passed`,
    );
  } finally {
    // Only this test's isolated project and temporary directories are disposable.
    await compose("down", "--volumes", "--remove-orphans");
    await rm(temp, { recursive: true, force: true });
  }
}
