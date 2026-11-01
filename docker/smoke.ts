import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

// Bun loads the developer's .env; do not let it override the isolated Compose env file.
const composeKeys = new Set([
  "ENCRYPTION_KEY",
  "INITIAL_OWNER_USERNAME",
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
// Deployment smoke test: packaged runtime, default setup and bind-mounted persistence.
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
  const username = "smoke-owner";
  const password = crypto.randomUUID();
  await writeFile(
    envFile,
    `ENCRYPTION_KEY=${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}
INITIAL_OWNER_USERNAME=${username}
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
      username,
      password,
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).user.role, "owner");
    cookie = result.headers.get("set-cookie")!.split(";")[0]!;
    csrf = (await (await request("/api/auth/session")).json()).csrfToken;
  }
  try {
    console.log(`${backend}: starting isolated deployment`);
    await compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "180");
    assert.equal((await request("/")).status, 200);
    assert.equal((await request("/app/images")).status, 200);
    await login();
    const png = await sharp({
      create: { width: 320, height: 160, channels: 3, background: "#42b883" },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png)], "sample.png"));
    const uploaded = await request("/api/files", "POST", form);
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const file = await uploaded.json();
    const path = new URL(file.url).pathname;
    assert.deepEqual(
      Buffer.from(await (await request(path)).arrayBuffer()),
      png,
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
    console.log(
      `${backend}: healthy startup, Owner login, default upload, original access and recreated-container persistence passed`,
    );
  } finally {
    // Only this test's isolated project and temporary directories are disposable.
    await compose("down", "--volumes", "--remove-orphans");
    await rm(temp, { recursive: true, force: true });
  }
}
