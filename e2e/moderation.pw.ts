import { test, expect, login } from "./fixtures";
import sharp from "sharp";
test.use({ scenario: "moderation" });
test("blocked images can be privately previewed and restored by an administrator", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("button", { name: "Upload images", exact: true })
    .first()
    .click();
  const buffer = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const uploaded = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/files" &&
      r.request().method() === "POST",
  );
  await page
    .getByTestId("upload-input")
    .setInputFiles({ name: "review.png", mimeType: "image/png", buffer });
  const result = await (await uploaded).json();
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(service.url + "/api/files/" + result.id)
          ).json()
        ).status,
    )
    .toBe("blocked");
  expect((await page.request.get(result.url)).status()).toBe(404);
  await page.getByLabel("File status", { exact: true }).selectOption("blocked");
  const card = page.getByTestId("file-card");
  await expect(card).toHaveCount(1);
  let detailRequests = 0;
  await page.route(`**/api/files/${result.id}`, async (route) => {
    detailRequests++;
    const response = await route.fetch();
    if (detailRequests === 1) {
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, status: "ready", backgroundPending: true },
      });
    } else await route.fulfill({ response });
  });
  let listRequests = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/files" &&
      request.method() === "GET"
    )
      listRequests++;
  });
  await card.getByRole("button", { name: /^Open / }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Public access is blocked.", { exact: true }),
  ).toBeVisible();
  await expect.poll(() => listRequests).toBeGreaterThan(0);
  await expect(dialog.locator("img")).toHaveAttribute(
    "src",
    /\/api\/files\/[^/]+\/preview$/,
  );
  await expect(dialog.locator("img")).toHaveJSProperty("naturalWidth", 32);
  await expect(dialog.getByLabel("Access link", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("heading", { name: "Processing Results" }),
  ).toBeVisible();
  await expect(dialog.getByText("Test content", { exact: true })).toBeVisible();
  await expect(dialog.getByText("82", { exact: true })).toBeVisible();

  await dialog
    .getByRole("button", { name: "Restore access", exact: true })
    .click();
  await expect(dialog.getByLabel("Access link", { exact: true })).toBeVisible();
  expect((await page.request.get(result.url)).status()).toBe(200);
  await expect(dialog.getByText("Test content", { exact: true })).toBeVisible();
  const settledRequests = detailRequests;
  await page.waitForTimeout(3500);
  expect(detailRequests).toBe(settledRequests);
});
