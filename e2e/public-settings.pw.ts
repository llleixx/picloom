import { test, expect, login } from "./fixtures";
import sharp from "sharp";

test("tokens support permanent and custom expiry with profile restrictions", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Upload Tokens", exact: true }).click();
  await page.getByLabel("Token name").fill("Permanent uploader");
  await page.getByLabel("Valid for").selectOption("never");
  await page.getByLabel("Upload access").selectOption("selected");
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  await page
    .getByRole("checkbox", { name: profiles[0].name, exact: true })
    .check();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  const secret = await page.getByLabel("New token").inputValue();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  let tokens = await (
    await page.request.get(service.url + "/api/tokens")
  ).json();
  expect(tokens[0].expiresAt).toBeNull();
  expect(tokens[0].profileIds).toEqual([profiles[0].id]);
  await expect(
    page.locator("p").filter({ hasText: "Never expires" }),
  ).toHaveCount(1);
  await page.getByLabel("Token name").fill("Custom uploader");
  await page.getByLabel("Valid for").selectOption("custom");
  await page.getByLabel("Expires at (local time)").fill("2030-01-01T12:00");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  tokens = await (await page.request.get(service.url + "/api/tokens")).json();
  expect(
    tokens.find((token: any) => token.name === "Custom uploader").expiresAt,
  ).toBeGreaterThan(Date.now());
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page
    .getByLabel("Current password", { exact: true })
    .fill("test-password-123");
  await page
    .getByLabel("New password", { exact: true })
    .fill("changed-password-123");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("changed-password-123");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page).toHaveURL(/login/);
  const response = await page.request.post(service.url + "/api/files", {
    headers: { Authorization: "Bearer " + secret },
    multipart: {
      profileId: profiles[0].id,
      file: {
        name: "a.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        ),
      },
    },
  });
  expect(response.status()).toBe(201);
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
      .getByLabel("Original URL", { exact: true })
      .inputValue();
    expect(new URL(original).hostname).toBe("localhost");
    await expect(
      page.getByRole("dialog").locator("img").first(),
    ).toHaveJSProperty("naturalWidth", 40);
    await page.getByLabel("Width", { exact: true }).fill("8");
    const request = page.waitForRequest((req) => req.url().includes("?w=8"));
    await page
      .getByRole("button", { name: "Generate preview", exact: true })
      .click();
    expect(new URL((await request).url()).origin).toBe(service.url);
    await expect(page.getByLabel("Processed URL", { exact: true })).toHaveValue(
      original + "?w=8&fit=inside",
    );
  });
});
