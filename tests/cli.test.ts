import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("documented initialization commands are repeatable", async () => {
  const root = await mkdtemp(join(tmpdir(), "star-cli-"));
  try {
    const run = async (command: string) => {
      const child = Bun.spawn([process.execPath, "run", command], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          DATA_DIR: root,
          ENCRYPTION_KEY: "cd".repeat(32),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(stderr);
      return stdout;
    };
    expect(await run("init-db")).toContain("Database initialized");
    expect(await run("init-db")).toContain("Database initialized");
    const first = JSON.parse(await run("init-dev"));
    const second = JSON.parse(await run("init-dev"));
    expect(second.profileId).toBe(first.profileId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
