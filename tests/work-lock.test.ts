import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workLock } from "../src/infra/files";

test.skipIf(process.platform !== "linux")(
  "work lock rejects the live process but recovers a reused Linux PID",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "picloom-lock-"));
    try {
      const unlock = await workLock(root);
      await expect(workLock(root)).rejects.toThrow("already in use");
      const path = join(root, "service.lock");
      const lock = JSON.parse(await readFile(path, "utf8"));
      expect(lock.processIdentity).toBeString();
      await unlock();
      await writeFile(
        path,
        JSON.stringify({ ...lock, processIdentity: "previous-boot:123" }),
      );
      const release = await workLock(root);
      await release();
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
