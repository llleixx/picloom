import { test, expect, login } from "./fixtures";
test("watermark uses the existing pipeline configuration form", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/app/config/pipelines");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Pipeline name", { exact: true })
    .fill("Watermark test");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page
    .getByLabel("Processor plugin", { exact: true })
    .selectOption("builtin.watermark@1.0.0");
  await expect(page.getByLabel("Size Mode", { exact: true })).toHaveValue('"relative"');
  await expect(page.getByLabel("Text", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Image Path", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Watermark Type", { exact: true })
    .selectOption("image");
  await expect(page.getByLabel("Image Path", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Text", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Image Width (%)", { exact: true })).toHaveValue(
    "10",
  );
  await page.getByLabel("Size Mode", { exact: true }).selectOption("fixed");
  await expect(
    page.getByLabel("Image Width (px)", { exact: true }),
  ).toHaveValue("128");
  await expect(page.getByLabel("Image Width (%)", { exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel("Size Mode", { exact: true }).selectOption("relative");
  await page.getByLabel("Watermark Type", { exact: true }).selectOption("text");
  await page.getByLabel("Text", { exact: true }).fill("© Demo");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Watermark test", exact: true }),
  ).toBeVisible();
});
