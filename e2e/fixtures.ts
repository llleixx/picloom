import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
export interface Service {
  root: string;
  url: string;
  uploadPeak: number;
  restart(): Promise<void>;
}
export const test = base.extend<{ service: Service; scenario: string }>({
  scenario: ["default", { option: true }],
  service: async ({ scenario }, use) => {
    const workspace = await mkdtemp(join(tmpdir(), "picloom-e2e-"));
    // Backups and restore staging live beside the application data directory.
    const root = scenario === "backup" ? join(workspace, "app") : workspace;
    const bun =
      process.env.BUN_BIN ??
      (existsSync(resolve("work/toolchain/bun-windows-x64/bun.exe"))
        ? resolve("work/toolchain/bun-windows-x64/bun.exe")
        : "bun");
    let child: ChildProcessWithoutNullStreams,
      url = "",
      output = "";
    async function start() {
      child = spawn(bun, ["e2e/server.ts"], {
        env: {
          ...process.env,
          E2E_ROOT: root,
          E2E_SCENARIO: scenario,
          E2E_PORT: url ? new URL(url).port : "0",
        },
        windowsHide: true,
        stdio: "pipe",
      });
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Server startup timeout: " + output)),
          20000,
        );
        child.stderr.on("data", (data) => (output += data.toString()));
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exit ${code}: ${output}`));
        });
        child.stdout.on("data", (data) => {
          output += data.toString();
          const match = output.match(/\{"ready":"([^"]+)"\}/);
          if (match) {
            url = match[1]!;
            clearTimeout(timer);
            resolveReady();
          }
        });
      });
    }
    async function stop() {
      if (!child || child.exitCode !== null) return;
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Shutdown timeout"));
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
        child.stdin.end("stop\n");
      });
    }
    try {
      await start();
      await use({
        root,
        get url() {
          return url;
        },
        get uploadPeak() {
          return Math.max(
            0,
            ...Array.from(output.matchAll(/\{"uploadPeak":(\d+)\}/g), (match) =>
              Number(match[1]),
            ),
          );
        },
        async restart() {
          await stop();
          output = "";
          await start();
        },
      });
    } finally {
      await stop();
      await rm(workspace, { recursive: true, force: true });
    }
  },
});
export { expect };
export async function login(page: Page, url: string) {
  await page.goto(url + "/app/images");
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Images", exact: true }),
  ).toBeVisible();
}
