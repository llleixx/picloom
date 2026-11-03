import {
  test,
  expect,
  login,
  selectImageFilter,
  expandDetails,
} from "./fixtures";
import sharp from "sharp";
import type { Page } from "@playwright/test";
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

test("upload, preview, copy, transform, and deletion use the real backend", async ({
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
  await selectImageFilter(page, "Image type", "image/png");
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.getByRole("button", { name: /^Open / }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const originalUrl = await page
    .getByLabel("Access link", { exact: true })
    .inputValue();
  await page
    .getByRole("group", { name: "Copy", exact: true })
    .filter({ has: page.getByLabel("Access link", { exact: true }) })
    .getByRole("button", { name: /^Copy (URL|Markdown|HTML|BBCode)$/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(originalUrl);
  await expandDetails(page, "link-parameters");
  for (const parameter of ["Width", "Output format"]) {
    await page
      .getByRole("button", { name: "Add parameter", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp("^" + parameter + "\\s") })
      .click();
  }
  await page.getByLabel("Width", { exact: true }).fill("20");
  await page.getByLabel("Output format").selectOption("webp");
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByLabel("Access link", { exact: true })).toHaveValue(
    originalUrl + "?w=20&format=webp",
  );
  await expect(page.locator("img").last()).toHaveJSProperty("naturalWidth", 20);

  await page.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByRole("button", { name: /^Open / }).click();
  await page.getByRole("button", { name: "Delete image", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () => (await page.request.get(originalUrl)).status())
    .toBe(404);
  expect(errors).toEqual([]);
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
