import { test, expect, login } from "./fixtures";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#6a91bd"/></svg>',
);
async function png() {
  return sharp({
    create: {
      width: 80,
      height: 60,
      channels: 4,
      background: { r: 50, g: 120, b: 200, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}
async function upload(
  page: Page,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
) {
  await page
    .getByRole("button", { name: "Upload images", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
  await page.getByTestId("upload-input").setInputFiles(files);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(
    files.length,
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("upload, preview, copy, transform, deletion and restart use the real backend", async ({
  page,
  context,
  service,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: service.url,
  });
  await login(page, service.url);
  await upload(page, [
    { name: "transparent.png", mimeType: "image/png", buffer: await png() },
    { name: "vector.svg", mimeType: "image/svg+xml", buffer: svg },
  ]);
  await expect(page.getByTestId("file-card")).toHaveCount(2);
  await page.getByLabel("Image type").selectOption("image/png");
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^Open / }).click();
  await expect(
    page.getByRole("heading", { name: "Image details" }),
  ).toBeVisible();
  const originalUrl = await page.getByLabel("Original URL").inputValue();
  await page
    .getByRole("group", { name: "Copy", exact: true })
    .filter({ has: page.getByLabel("Original URL", { exact: true }) })
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(originalUrl);
  await page.getByLabel("Width", { exact: true }).fill("20");
  await page.getByLabel("Output format").selectOption("webp");
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByLabel("Processed URL")).toHaveValue(
    originalUrl + "?w=20&fit=inside&format=webp",
  );
  await page.getByLabel("Output format").selectOption("jpeg");
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("transparency");
  await expect(page.getByLabel("Processed URL")).toHaveCount(0);
  await page.getByLabel("Width", { exact: true }).fill("90000");
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  expect(
    await page
      .getByLabel("Width", { exact: true })
      .evaluate((el) => (el as HTMLInputElement).validity.rangeOverflow),
  ).toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await service.restart();
  await page.reload();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  expect((await page.request.get(originalUrl)).status()).toBe(200);
  await page.getByRole("button", { name: /^Open / }).click();
  await page.getByRole("button", { name: "Delete image", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.locator("dd").filter({ hasText: /^Deleted$/ }),
  ).toBeVisible();
  expect((await page.request.get(originalUrl)).status()).toBe(404);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByLabel("Image type").selectOption("image/svg+xml");
  await page.getByRole("button", { name: /^Open / }).click();
  await expect(
    page.getByText("Processing supports static", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("img").last()).toHaveJSProperty("naturalWidth", 80);
  expect(errors).toEqual([]);
});

test("token lifecycle, incorrect password, password revocation and expiration", async ({
  page,
  service,
  context,
}) => {
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
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page
    .getByLabel("Current password", { exact: true })
    .fill("wrong-password");
  await page
    .getByLabel("New password", { exact: true })
    .fill("new-password-123");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("new-password-123");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Current password is incorrect.",
  );
  await expect(page).toHaveURL(/\/app\/account$/);
  await page
    .getByLabel("Current password", { exact: true })
    .fill("test-password-123");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("new-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/images$/);
  await context.clearCookies();
  await page.getByRole("link", { name: "Upload Tokens", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Session expired. Sign in again.")).toBeVisible();
});

test("invalid uploads are isolated; clipboard and drag-drop enqueue real files", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("button", { name: "Upload images", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Choose files" }),
  ).toBeEnabled();
  await page.getByTestId("upload-input").setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("invalid"),
  });
  await expect(page.getByTestId("upload-row")).toContainText("Invalid image");
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "pasted.svg", { type: "image/svg+xml" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data }));
  }, svg.toString());
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(1);
  const drop = await page.evaluateHandle((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], "dropped.svg", { type: "image/svg+xml" }));
    return data;
  }, svg.toString());
  await page
    .getByText("Drop images here", { exact: true })
    .dispatchEvent("drop", { dataTransfer: drop });
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(2);
});

test.describe("pagination", () => {
  test.use({ scenario: "seed" });
  test("filters, paging, deep links, themes and mobile navigation", async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    await expect(page.getByTestId("file-card")).toHaveCount(24);
    await mkdir("outputs", { recursive: true });
    await expect
      .poll(() =>
        page
          .locator('[data-testid="file-card"] img')
          .evaluateAll((images) =>
            images
              .slice(0, 8)
              .every((image) => (image as HTMLImageElement).naturalWidth > 0),
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: "outputs/admin-desktop.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await page.reload();
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await page.getByRole("button", { name: "List view" }).click();
    await page.getByRole("button", { name: "Dark mode" }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Light mode" }).click();
    await page.getByRole("button", { name: /^Open / }).click();
    const url = await page.getByLabel("Original URL").inputValue();
    const id = new URL(url).pathname.split("/").pop()!.replace(".png", "");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Image details" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByLabel("Search images").fill(id);
    await page.getByLabel("Search images").press("Enter");
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "outputs/admin-mobile.png",
      fullPage: false,
    });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page
      .getByRole("dialog")
      .getByRole("link", { name: "Account", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Account", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});

test.describe("empty configuration", () => {
  test.use({ scenario: "no-profile" });
  test("no available profile disables upload", async ({ page, service }) => {
    await login(page, service.url);
    await page
      .getByRole("button", { name: "Upload images", exact: true })
      .first()
      .click();
    await expect(
      page.getByText("No available profiles", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Choose files" }),
    ).toBeDisabled();
  });
});

test.describe("upload queue", () => {
  test.use({ scenario: "queue" });
  test("concurrency stays at two, limits prevent upload and navigation preserves the queue", async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    let sent = 0;
    const isUpload = (request: import("@playwright/test").Request) =>
      new URL(request.url()).pathname === "/api/files" &&
      request.method() === "POST";
    page.on("request", (request) => {
      if (isUpload(request)) sent++;
    });
    await page
      .getByRole("button", { name: "Upload images", exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Choose files" }),
    ).toBeEnabled();
    await page.getByTestId("upload-input").setInputFiles({
      name: "too-big.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(1025),
    });
    await expect(page.getByTestId("upload-row")).toContainText(
      "exceeds the upload limit",
    );
    expect(sent).toBe(0);
    await page.getByTestId("upload-input").setInputFiles(
      Array.from({ length: 6 }, (_, i) => ({
        name: `${i}.svg`,
        mimeType: "image/svg+xml",
        buffer: svg,
      })),
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("link", { name: "Upload Tokens", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(service.url + "/api/files?status=ready")
            ).json()
          ).length,
      )
      .toBe(6);
    expect(service.uploadPeak).toBe(2);
    expect(sent).toBe(6);
    await page.getByRole("link", { name: "Images", exact: true }).click();
    await page
      .getByRole("button", { name: "Upload images", exact: true })
      .click();
    await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(6);
  });
});

test.describe("deletion failure", () => {
  test.use({ scenario: "delete-failure" });
  test("failed cleanup remains visible and old link stops serving", async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    await upload(page, [
      { name: "vector.svg", mimeType: "image/svg+xml", buffer: svg },
    ]);
    await page.getByRole("button", { name: /^Open / }).click();
    const url = await page.getByLabel("Original URL").inputValue();
    await page
      .getByRole("button", { name: "Delete image", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete", exact: true })
      .click();
    await expect(
      page.getByText(/^Cleanup failed\. Check storage/),
    ).toBeVisible();
    expect((await page.request.get(url)).status()).toBe(404);
  });
});
