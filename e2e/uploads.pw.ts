import { test, expect, login } from "./fixtures";
import sharp from "sharp";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function largePng() {
  const png = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  return Buffer.concat([png, Buffer.alloc(9 * 1024 ** 2)]);
}

test("large uploads retry only failed parts and safely repeat a lost completion response", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Picloom", exact: true }).click();
  const attempts = new Map<string, number>();
  let failParts = true;
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    const index = route.request().url().split("/").pop()!;
    attempts.set(index, (attempts.get(index) ?? 0) + 1);
    if (index === "1" && failParts)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "BUSY", message: "injected" } }),
      });
    else await route.continue();
  });
  let loseCompletion = true;
  const results: string[] = [];
  await page.route("**/api/uploads/*/complete", async (route) => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    results.push((await response.json()).id);
    if (loseCompletion) {
      loseCompletion = false;
      await route.abort();
    } else await route.fulfill({ response });
  });
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
  await page.getByTestId("upload-input").setInputFiles({
    name: "large.png",
    mimeType: "image/png",
    buffer: await largePng(),
  });
  await expect(
    page.getByRole("button", { name: "Continue upload", exact: true }),
  ).toBeVisible();
  expect(attempts.get("1")).toBe(3);
  const partZero = attempts.get("0");
  failParts = false;
  await page
    .getByRole("button", { name: "Continue upload", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue upload", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue upload", exact: true })
    .click();
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  expect(attempts.get("0")).toBe(partZero);
  expect(results).toHaveLength(2);
  expect(results[0]).toBe(results[1]);
  await page.getByRole("link", { name: "App" }).click();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  expect(await readdir(join(service.root, "uploads"))).toEqual([]);
});
