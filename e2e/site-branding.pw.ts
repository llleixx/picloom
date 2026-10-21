import { test, expect, login } from "./fixtures";

test("branding translations update all pages and can be cleared", async ({
  page,
  service,
}) => {
  await page.addInitScript(() => localStorage.setItem("language", "en"));
  await login(page, service.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("textbox", { name: /^Site name · / }).fill("My Gallery");
  await page
    .getByRole("textbox", { name: /^Short description · / })
    .fill("A custom image library");
  await page
    .getByRole("button", { name: "Edit translations · Site name", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("English", { exact: true })).toHaveValue(
    "My Gallery",
  );
  await dialog.getByLabel("English", { exact: true }).fill("Discarded gallery");
  await dialog.getByLabel("简体中文", { exact: true }).fill("取消的名称");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Site name · English", exact: true }),
  ).toHaveValue("My Gallery");
  await page
    .getByRole("button", { name: "Edit translations · Site name", exact: true })
    .click();
  await expect(dialog.getByLabel("简体中文", { exact: true })).not.toHaveValue(
    "取消的名称",
  );
  await dialog.getByLabel("简体中文", { exact: true }).fill("我的图库");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  const beforeSave = await (
    await page.request.get(service.url + "/api/settings")
  ).json();
  expect(beforeSave.content["zh-CN"]?.name).not.toBe("我的图库");
  await page
    .getByLabel("Logo URL", { exact: true })
    .fill(service.url + "/missing-logo.png");
  await page
    .getByLabel("Favicon URL", { exact: true })
    .fill(service.url + "/missing-icon.ico");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveTitle("Settings · My Gallery");
  await expect(
    page.locator("aside").getByText("My Gallery", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("aside img")).toHaveCount(0);
  await page.goto(service.url);
  await expect(
    page.getByRole("heading", { name: "My Gallery", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A custom image library", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Upload · My Gallery");
  await page.goto(service.url + "/login");
  await expect(page.getByText("My Gallery", { exact: true })).toBeVisible();
  await expect(
    page.getByText("A custom image library", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Sign in · My Gallery");
  await page.goto(service.url + "/app/settings");
  for (const name of [
    "Site name",
    "Short description",
    "Logo URL",
    "Favicon URL",
  ])
    await page
      .getByRole("textbox", { name: new RegExp("^" + name + "(?: · .+)?$") })
      .fill("");
  await page
    .getByRole("button", { name: "Edit translations · Site name", exact: true })
    .click();
  await dialog.getByLabel("简体中文", { exact: true }).fill("");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveTitle(/^Settings\s*·?\s*$/);
  await expect(page.locator("aside img")).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveCount(0);
});
