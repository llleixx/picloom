import { test, expect, login } from "./fixtures";
import sharp from "sharp";
import type { FileView } from "../shared/api";

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
  await expect(card.locator("img")).toHaveAttribute("src", /^blob:/);
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

test("thumbnail requests share eight slots and pagination discards queued images", async ({
  page,
  service,
}) => {
  await page.setViewportSize({ width: 1440, height: 4000 });
  await page.addInitScript(() => localStorage.setItem("fileView", "list"));
  await page.route("**/api/files?*", async (route) => {
    const offset = Number(
      new URL(route.request().url()).searchParams.get("offset"),
    );
    const items: FileView[] = Array.from({ length: 24 }, (_, index) => {
      const id = `file-${offset + index}`;
      return {
        id,
        ownerId: null,
        tags: [],
        status: "ready",
        mimeType: "image/png",
        byteSize: 100,
        width: 40,
        height: 20,
        publicPrefix: "",
        logicalKey: `${id}.png`,
        storageKey: `${id}.png`,
        createdAt: 1,
        deletedAt: null,
        error: null,
        url: `${service.url}/${id}.png`,
      };
    });
    await route.fulfill({ json: items, headers: { "X-Total-Count": "48" } });
  });
  const image = await sharp({
    create: { width: 40, height: 20, channels: 3, background: "red" },
  })
    .webp()
    .toBuffer();
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let hold = true;
  await page.route("**/api/files/*/thumbnail", async (route) => {
    started.push(new URL(route.request().url()).pathname.split("/")[3]!);
    if (hold) await new Promise<void>((resolve) => releases.push(resolve));
    await route
      .fulfill({ contentType: "image/webp", body: image })
      .catch(() => {});
  });
  try {
    await login(page, service.url);
    await expect(page.getByTestId("file-card")).toHaveCount(24);
    await expect.poll(() => started.length).toBe(8);
    releases.shift()!();
    await expect.poll(() => started.length).toBe(9);
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByTestId("file-card").first()).toContainText(
      "file-24.png",
    );
    await expect
      .poll(() => started.filter((id) => Number(id.slice(5)) >= 24).length)
      .toBe(8);
    hold = false;
    releases.splice(0).forEach((release) => release());
    await expect(page.getByTestId("file-card").locator("img")).toHaveCount(24);
    for (const img of await page.getByTestId("file-card").locator("img").all())
      await expect(img).toHaveJSProperty("naturalWidth", 40);
    expect(started.filter((id) => Number(id.slice(5)) < 24)).toHaveLength(9);
  } finally {
    hold = false;
    releases.splice(0).forEach((release) => release());
  }
});
