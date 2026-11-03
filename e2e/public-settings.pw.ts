import { test, expect, login, expandDetails } from "./fixtures";
import sharp from "sharp";

test("upload tokens can be created and revoked", async ({ page, service }) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Upload Tokens", exact: true }).click();
  await page.getByLabel("Token name").fill("Blog");
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByLabel("New token").inputValue();
  expect(token.length).toBeGreaterThan(30);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await expect(page.getByLabel("New token")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
});

test.describe("separate image domain", () => {
  test.use({ scenario: "image-origin" });
  test("image embedding and processing previews work without CORS", async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    await page
      .getByRole("button", { name: "Upload images", exact: true })
      .first()
      .click();
    const buffer = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    await page
      .getByTestId("upload-input")
      .setInputFiles({ name: "a.png", mimeType: "image/png", buffer });
    await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: /^Open / }).click();
    const original = await page
      .getByLabel("Access link", { exact: true })
      .inputValue();
    expect(new URL(original).hostname).toBe("localhost");
    await expect(
      page.getByRole("dialog").locator("img").first(),
    ).toHaveJSProperty("naturalWidth", 40);
    await expandDetails(page, "link-parameters");
    await page
      .getByRole("button", { name: "Add parameter", exact: true })
      .click();
    await page.getByRole("button", { name: /^Width\s/ }).click();
    await page.getByLabel("Width", { exact: true }).fill("8");
    const request = page.waitForRequest((req) => req.url().includes("?w=8"));
    await page
      .getByRole("button", { name: "Generate preview", exact: true })
      .click();
    expect(new URL((await request).url()).origin).toBe(service.url);
    await expect(page.getByLabel("Access link", { exact: true })).toHaveValue(
      original + "?w=8",
    );
    await expect(
      page.getByRole("dialog").locator('img[src^="blob:"]'),
    ).toHaveJSProperty("naturalWidth", 8);
  });
});
