import { test, expect } from "./fixtures";

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
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Picloom", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Picloom", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeEnabled();
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
  await page.getByRole("link", { name: "App" }).click();
  await expect(
    page.getByRole("heading", { name: "Images", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("complementary")
    .getByRole("link", { name: "Picloom", exact: true })
    .click();
  // Entering the workspace loads a separate document; completed queues are not persisted.
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(0);
});
