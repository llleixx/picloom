import { test, expect, login } from "./fixtures";

test("upload homepage, batch auto-copy and workspace navigation", async ({
  page,
  context,
  service,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(service.url + "/");
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Upload", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Picloom", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
  const drop = await page
    .getByRole("button", { name: "Drop images here", exact: true })
    .boundingBox();
  const profile = await page
    .getByLabel("Upload profile", { exact: true })
    .boundingBox();
  expect(profile!.y).toBeGreaterThan(drop!.y + drop!.height);
  let fileChoosers = 0;
  page.on("filechooser", () => fileChoosers++);
  const copySettings = page.getByRole("button", { name: /^Copy format:/ });
  const copyFormat = (name: string) =>
    page.getByRole("button", { name, exact: true });
  await copySettings.click();
  await expect(copyFormat("URL")).toHaveAttribute("aria-pressed", "true");
  await copyFormat("Markdown").click();
  await expect(copyFormat("Markdown")).not.toBeVisible();
  await copySettings.click();
  await page.getByLabel("Auto-copy after upload").check();
  await page.keyboard.press("Escape");
  await expect(copyFormat("Markdown")).not.toBeVisible();
  expect(fileChoosers).toBe(0);
  const buffer = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="green"/></svg>',
  );
  await page.getByTestId("upload-input").setInputFiles([
    { name: "one.svg", mimeType: "image/svg+xml", buffer },
    { name: "two.svg", mimeType: "image/svg+xml", buffer },
  ]);
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^!\[\]\(https?:\/\/[^<>\n]+\)\n!\[\]\(https?:\/\/[^<>\n]+\)$/);
  await copySettings.click();
  await copyFormat("HTML").click();
  await page.getByRole("button", { name: "Copy all", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^<img src=.+\n<img src=/);
  await copySettings.click();
  await copyFormat("BBCode").click();
  await page
    .getByRole("group", { name: "Copy", exact: true })
    .first()
    .getByRole("button", { name: "Copy", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^\[img\].+\[\/img\]$/);
  await page.getByRole("link", { name: "App" }).click();
  await expect(
    page.getByRole("heading", { name: "Images", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Upload", exact: true }).click();
  // Entering the workspace loads a separate document; completed queues are not persisted.
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "App" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await copySettings.click();
  await expect(page.getByLabel("Auto-copy after upload")).toBeChecked();
  await expect(copyFormat("BBCode")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "Add tags", exact: true }).click();
    await expect(
      page.getByRole("group", { name: "Tags", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await copySettings.click();
    const settingsBox = await page
      .locator("details[open] .upload-popover-content")
      .boundingBox();
    expect(settingsBox!.x).toBeGreaterThanOrEqual(0);
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
  }
});

test("app navigation shares groups and breadcrumbs on desktop and mobile", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/app/users");
  await expect(page.locator("header")).toContainText("Administration");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("region", { name: "Administration" })
      .getByRole("link", { name: "Users", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await expect(page.locator("header")).toContainText("Configuration");
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(page.locator("header")).toContainText("Account");
  await expect(page.locator("header")).not.toContainText("Configuration");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("region", { name: "Library" })).toBeVisible();
  await drawer.getByRole("link", { name: "Users", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator("header")).toContainText("Administration");
});

test("pasted image URLs join the upload queue without intercepting text inputs", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/");
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
  const requests: string[] = [];
  await page.route("**/api/files/from-url", async (route) => {
    requests.push(route.request().postDataJSON().url);
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "REMOTE_IMAGE_FAILED", message: "Download failed" },
      }),
    });
  });
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData(
      "text/plain",
      "https://example.com/one.png https://example.com/two.svg",
    );
    document.body.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual([
    "https://example.com/one.png",
    "https://example.com/two.svg",
  ]);
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Dismiss", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "Dismiss", exact: true }),
  ).toHaveCount(1);
  await page.evaluate(() => {
    const input = document.createElement("input");
    document.body.append(input);
    const data = new DataTransfer();
    data.setData("text/plain", "https://example.com/ignored.png");
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    input.remove();
    if (event.defaultPrevented) throw new Error("Input paste intercepted");
  });
});
