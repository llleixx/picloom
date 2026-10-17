import { test, expect, login } from "./fixtures";
import { demoPackage } from "../tests/package-fixtures";
test("install a ZIP, create an instance, block referenced uninstall, remove instance and uninstall", async ({
  page,
  service,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, service.url);
  await page.getByRole("link", { name: "Plugins", exact: true }).click();
  const packages = await (
    await page.request.get(service.url + "/api/plugin-packages")
  ).json();
  const builtinCount = packages.filter(
    (plugin: { source: string }) => plugin.source === "builtin",
  ).length;
  expect(builtinCount).toBeGreaterThan(0);
  await expect(page.getByText("Built-in · Protected")).toHaveCount(
    builtinCount,
  );
  await expect(
    page.getByRole("button", { name: "Uninstall", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Upload package", { exact: true }).setInputFiles({
    name: "example.zip",
    mimeType: "application/zip",
    buffer: demoPackage(),
  });
  await expect(
    page.getByRole("dialog", { name: "Install plugin?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Install", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I trust this plugin and allow it to run." })
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const card = page.locator("article").filter({
    has: page.getByRole("heading", {
      name: "Example path plugin",
      exact: true,
    }),
  });
  await expect(card.getByText("Loaded", { exact: true })).toBeVisible();
  await expect(card.getByText("References: 0", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "outputs/plugins-management.png",
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Profile name", { exact: true })
    .fill("Install test profile");
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("example.date@1.0.0");
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  )[0];
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Plugins", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Uninstall", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  const ownerRow = page
    .getByRole("heading", { name: "Install test profile", exact: true })
    .locator("../..");
  await ownerRow.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Plugins", exact: true }).click();
  await card.getByRole("button", { name: "Uninstall", exact: true }).click();
  await page
    .getByRole("button", { name: "Uninstall plugin", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await service.restart();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Example path plugin", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
