import { test, expect, login } from "./fixtures";
import sharp from "sharp";

test.use({ scenario: "seed" });
test("replace from image details keeps the link and opens the new image", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const files = await (
    await page.request.get(service.url + "/api/files")
  ).json();
  const old = Array.isArray(files) ? files[0] : files.items[0];
  await page.goto(`${service.url}/app/images?file=${old.id}`);
  await page
    .getByRole("button", { name: "Replace image", exact: true })
    .click();
  const dialog = page
    .getByRole("dialog")
    .filter({
      has: page.getByRole("heading", { name: "Replace image", exact: true }),
    });
  const buffer = await sharp({
    create: { width: 17, height: 9, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer });
  const completed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/files/${old.id}/replace`) &&
      r.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Replace image", exact: true })
    .click();
  const response = await completed;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.id).not.toBe(old.id);
  expect(new URL(result.url).pathname).toBe(new URL(old.url).pathname);
  await expect(page).toHaveURL(new RegExp(`file=${result.id}`));
  await expect(
    page.getByRole("button", { name: "Replace image", exact: true }),
  ).toBeVisible();
  const image = await page.request.get(result.url);
  expect(image.ok()).toBe(true);
  expect(await image.body()).toEqual(buffer);
});
