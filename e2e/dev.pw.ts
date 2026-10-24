import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { test, expect, login } from "./fixtures";
test.use({ scenario: "dev" });
test("Vite proxy keeps login, upload URL and image access on the browser origin", async ({
  page,
  service,
}) => {
  const bun =
    process.env.BUN_BIN ??
    (existsSync(resolve("work/toolchain/bun-windows-x64/bun.exe"))
      ? resolve("work/toolchain/bun-windows-x64/bun.exe")
      : "bun");
  const child = spawn(
    bun,
    [
      "--bun",
      "node_modules/vite/bin/vite.js",
      "--config",
      "web/vite.config.ts",
    ],
    {
      env: { ...process.env, BACKEND_URL: service.url },
      windowsHide: true,
      stdio: "pipe",
    },
  );
  let output = "";
  child.stderr.on("data", (data) => (output += data));
  child.stdout.on("data", (data) => (output += data));
  try {
    await expect
      .poll(async () => {
        if (child.exitCode !== null) throw new Error(output);
        return fetch("http://127.0.0.1:5173/")
          .then((r) => r.status)
          .catch(() => 0);
      })
      .toBe(200);
    await login(page, "http://127.0.0.1:5173");
    await page
      .getByRole("button", { name: "Upload images", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Choose files" }),
    ).toBeEnabled();
    await page.getByTestId("upload-input").setInputFiles({
      name: "dev.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15"/></svg>',
      ),
    });
    await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /^Open / }).click();
    const url = await page
      .getByRole("textbox", { name: "Access link", exact: true })
      .inputValue();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:5173\/i\//);
    expect((await page.request.get(url)).status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    if (child.exitCode === null)
      await new Promise<void>((done) => {
        child.once("exit", () => done());
        child.kill();
      });
  }
});
