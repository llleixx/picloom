import sharp from "sharp";
import { test, expect, login, expandDetails } from "./fixtures";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
test("import from a source, rescan, preview and delete the original", async ({
  page,
  service,
}) => {
  const folder = join(service.root, "originals", "legacy");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "sample.png"),
    await sharp({
      create: { width: 40, height: 20, channels: 3, background: "green" },
    })
      .png()
      .toBuffer(),
  );
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Storage Sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Scan scope (optional)").fill("legacy/");
  await page.getByLabel("Public prefix", { exact: true }).fill("/old/");
  const importTags = page.getByRole("group", { name: "Tags", exact: true });
  await importTags.getByLabel("Search tags", { exact: true }).fill("Legacy");
  await importTags.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    importTags.getByRole("button", { name: "Remove Legacy", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(page.getByText("Scan complete.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Scanned 1 · Imported 1/)).toBeVisible();
  await importTags
    .getByRole("button", { name: "Remove Legacy", exact: true })
    .click();
  await page.getByRole("button", { name: "Start import", exact: true }).click();
  await expect(
    page.getByText(/Scanned 1 · Imported 0 · Skipped 1/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.getByRole("link", { name: "Images", exact: true }).click();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^Open / }).click();
  await expect(page.getByLabel("Access link", { exact: true })).toHaveValue(
    service.url + "/old/legacy/sample.png",
  );
  const original = await page.request.get(
    service.url + "/old/legacy/sample.png",
  );
  expect(original.headers()["content-type"]).toContain("image/png");
  await expect(
    page.getByRole("dialog").getByText("Legacy", { exact: true }),
  ).toBeVisible();
  await expandDetails(page, "link-parameters");
  await page
    .getByRole("button", { name: "Add parameter", exact: true })
    .click();
  await page.getByRole("button", { name: "Width w", exact: true }).click();
  await page.getByLabel("Width", { exact: true }).fill("20");
  await page
    .getByRole("button", { name: "Add parameter", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Output format format", exact: true })
    .click();
  await page.getByLabel("Output format").selectOption("webp");
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByLabel("Access link", { exact: true })).toHaveValue(
    service.url + "/old/legacy/sample.png?w=20&format=webp",
  );
  await page
    .getByRole("button", { name: "Delete image", exact: true })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect
    .poll(async () => {
      try {
        await access(join(folder, "sample.png"));
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
});
