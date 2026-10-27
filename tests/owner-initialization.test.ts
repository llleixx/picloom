import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, type Application } from "../src/bootstrap";
import { startRuntime } from "../src/runtime";

const password = "owner-password-123";
const config = (root: string) => ({
  root,
  databaseUrl: "",
  encryptionKey: "ab".repeat(32),
  origin: "http://localhost",
});

async function withApp(run: (app: Application) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "picloom-owner-init-"));
  let app: Application | undefined;
  try {
    app = await bootstrap(config(root));
    await run(app);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
}

test.each([undefined, "", " \t "])(
  "initial Owner defaults to admin for username %j",
  async (username) => {
    await withApp(async (app) => {
      expect(await app.auth.initializeOnStartup(password, username)).toBeNull();
      const login = await app.auth.login("admin", password, "test");
      expect(login.user.role).toBe("owner");
    });
  },
);

test.each([" Mixed.Owner_1- ", "A".repeat(64)])(
  "initial Owner accepts and normalizes username %j",
  async (username) => {
    await withApp(async (app) => {
      await app.auth.initializeOnStartup(password, username);
      const login = await app.auth.login(username, password, "test");
      expect(login.user.username).toBe(username.trim().toLowerCase());
      expect(login.user.role).toBe("owner");
    });
  },
);

test.each(["bad/name", "用户名", "a".repeat(65)])(
  "initial Owner rejects invalid username %j without creating an account",
  async (username) => {
    await withApp(async (app) => {
      await expect(
        app.auth.initializeOnStartup(password, username),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await app.db.read((r) => r.userCount())).toBe(0);
    });
  },
);

test("runtime logs the actual generated Owner once and ignores later initial credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-owner-runtime-"));
  const messages: string[] = [];
  const options = { sweep: false, log: (s: string) => messages.push(s) };
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime(config(root), {
      ...options,
      initialUsername: " Custom.Owner ",
      initialPassword: "",
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Initial Owner: custom.owner\n");
    const generated = messages[0]!.match(
      /Initial password: ([A-Za-z0-9_-]+)/,
    )![1]!;
    const original = (
      await runtime.app.auth.login("custom.owner", generated, "test")
    ).user;
    expect(original.role).toBe("owner");
    await runtime.close();
    runtime = undefined;

    for (const username of ["another-owner", "invalid/name"]) {
      runtime = await startRuntime(config(root), {
        ...options,
        initialUsername: username,
        initialPassword: "short",
      });
      expect(messages).toHaveLength(1);
      expect(await runtime.app.db.read((r) => r.userCount())).toBe(1);
      const login = await runtime.app.auth.login(
        "custom.owner",
        generated,
        "test",
      );
      expect(login.user.id).toBe(original.id);
      expect(login.user.password_hash).toBe(original.password_hash);
      await runtime.close();
      runtime = undefined;
    }
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime reads initial username from environment and explicit options take precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "picloom-owner-env-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { startRuntime } from "./src/runtime";
         const base = ${JSON.stringify(config(root))};
         for (const [name, options] of [
           ["env.owner", {}],
           ["option.owner", { initialUsername: " Option.Owner " }],
           ["admin", { initialUsername: "" }],
         ]) {
           const runtime = await startRuntime({ ...base, root: base.root + "/" + name }, {
             ...options, sweep: false, log: () => {},
           });
           try {
             const login = await runtime.app.auth.login(name, ${JSON.stringify(password)}, "test");
             if (login.user.username !== name || login.user.role !== "owner")
               throw new Error("Unexpected Owner account");
           } finally { await runtime.close(); }
         }`,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          INITIAL_OWNER_USERNAME: " Env.Owner ",
          INITIAL_OWNER_PASSWORD: password,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
