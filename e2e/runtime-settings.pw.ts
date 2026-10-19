import { test, expect, login } from "./fixtures";
import sharp from "sharp";

test("web settings change chunking and browser concurrency, with advanced options below their toggle", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Chunk threshold (MiB)", { exact: true }).fill("1");
  await page.getByLabel("Chunk size (MiB)", { exact: true }).fill("0.5");
  await page.getByLabel("Concurrent files", { exact: true }).fill("1");
  await page
    .getByLabel("Concurrent chunks per file", { exact: true })
    .fill("1");
  const uploadSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Upload", exact: true }),
  });
  await expect(page.getByLabel("Temporary cache limit (MiB)")).toBeVisible();
  await expect(
    page.getByText(
      "Covers upload staging, chunks and processing files, including background task usage and reservations. New reservations or writes are rejected when full.",
    ),
  ).toBeVisible();
  const toggle = uploadSection.getByRole("button", {
    name: "Show advanced",
    exact: true,
  });
  await toggle.click();
  const y = (await uploadSection
    .getByRole("button", { name: "Hide advanced", exact: true })
    .boundingBox())!.y;
  expect(
    (await page.getByLabel("Unfinished upload sessions").boundingBox())!.y,
  ).toBeGreaterThan(y);
  await page.getByLabel("Upload session lifetime (hours)").fill("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved");
  let active = 0,
    peak = 0,
    parts = 0,
    creations = 0,
    completions = 0,
    pending = 0,
    filePeak = 0;
  page.on("response", (response) => {
    if (response.url().endsWith("/api/uploads") && response.status() === 201) {
      creations++;
      pending++;
      filePeak = Math.max(filePeak, pending);
    }
    if (response.url().endsWith("/complete") && response.ok()) {
      completions++;
      pending--;
    }
  });
  await page.route("**/api/uploads/*/parts/*", async (route) => {
    active++;
    peak = Math.max(peak, active);
    parts++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = await route.fetch();
    active--;
    await route.fulfill({ response });
  });
  await page.getByRole("link", { name: "Upload", exact: true }).click();
  const png = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const buffer = Buffer.concat([png, Buffer.alloc(1024 ** 2)]);
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
  await page.getByTestId("upload-input").setInputFiles(
    [1, 2, 3].map((i) => ({
      name: `${i}.png`,
      mimeType: "image/png",
      buffer,
    })),
  );
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(3);
  expect(creations).toBe(3);
  expect(completions).toBe(3);
  expect(filePeak).toBe(1);
  expect(parts).toBe(9);
  expect(peak).toBe(1);
  await service.restart();
  await page.goto(service.url + "/app/settings");
  await expect(
    page.getByLabel("Chunk size (MiB)", { exact: true }),
  ).toHaveValue("0.5");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
