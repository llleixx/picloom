import { test, expect, login } from "./fixtures";
import sharp from "sharp";

test("list loads thumbnails, retry stays on thumbnail endpoint, preview uses original", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("button", { name: "Upload images", exact: true })
    .first()
    .click();
  const buffer = await sharp({
    create: {
      width: 1000,
      height: 600,
      channels: 4,
      background: { r: 80, g: 100, b: 120, alpha: 0.4 },
    },
  })
    .png()
    .toBuffer();
  await page
    .getByTestId("upload-input")
    .setInputFiles({ name: "large.png", mimeType: "image/png", buffer });
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const card = page.getByTestId("file-card");
  await expect(card.locator("img")).toHaveAttribute(
    "src",
    /\/api\/files\/[^/]+\/thumbnail$/,
  );
  await expect(card.locator("img")).toHaveJSProperty("naturalWidth", 480);
  await card.getByRole("button", { name: /^Open / }).click();
  await expect(
    page.getByRole("dialog").locator("img").first(),
  ).toHaveJSProperty("naturalWidth", 1000);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.route("**/api/files/*/thumbnail", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.reload();
  await expect(card.getByText("Image failed to load")).toBeVisible();
  await page.unroute("**/api/files/*/thumbnail");
  const retry = page.waitForRequest((req) => req.url().endsWith("/thumbnail"));
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await retry;
  await expect(card.locator("img")).toHaveJSProperty("naturalWidth", 480);
});
