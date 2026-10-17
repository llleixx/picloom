import { test, expect, login } from "./fixtures";

test("branding updates all pages and resets to defaults", async ({
  page,
  service,
}) => {
  await page.addInitScript(() => localStorage.setItem("language", "en"));
  await login(page, service.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Site name", { exact: true }).fill("My Gallery");
  await page
    .getByLabel("Short description", { exact: true })
    .fill("A custom image library");
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
  await expect(page.locator("aside img")).toHaveAttribute("src", /picloom.*\.svg/);
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
    await page.getByLabel(name, { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveTitle("Settings · Picloom");
  await expect(page.locator("aside img")).toHaveAttribute("src", /picloom.*\.svg/);
  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  const asset = await page.request.get(new URL(icon!, service.url).href);
  expect(asset.ok()).toBe(true);
  expect(asset.headers()["content-type"]).toContain("image/svg+xml");
  expect(await asset.text()).toContain("<svg");
  await expect(page.locator('link[rel="icon"]')).not.toHaveAttribute(
    "href",
    /missing-icon/,
  );
});
