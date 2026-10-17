import { test, expect, login } from "./fixtures";

test("settings edit, validation, restart and mobile navigation", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/app\/settings$/);
  await expect(page.getByLabel("Site origin", { exact: true })).toHaveValue(
    service.url,
  );
  await page.getByLabel("Site origin", { exact: true }).fill(service.url + "/");
  await page
    .getByLabel("Public image origin", { exact: true })
    .fill("https://images.example.com/path");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Use an HTTP(S) origin without a path."),
  ).toBeVisible();
  await page
    .getByLabel("Public image origin", { exact: true })
    .fill("https://images.example.com");
  await page.getByLabel("Enable hotlink protection").check();
  await page.getByLabel("Cache lifetime (seconds)").fill("3600");
  await page.getByLabel("Capacity (MiB)").fill("128");
  await page.getByLabel("Retention (minutes)").fill("60");
  await page
    .getByLabel("Allowed domains", { exact: true })
    .fill("example.com\n*.example.com");
  await page.getByLabel("Allow requests without Referer").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved");
  await service.restart();
  await page.reload();
  await expect(page.getByLabel("Site origin", { exact: true })).toHaveValue(
    service.url,
  );
  await expect(
    page.getByLabel("Public image origin", { exact: true }),
  ).toHaveValue("https://images.example.com");
  await expect(page.getByLabel("Allowed domains", { exact: true })).toHaveValue(
    "example.com\n*.example.com",
  );
  await expect(
    page.getByLabel("Allow requests without Referer"),
  ).not.toBeChecked();
  await expect(page.getByLabel("Cache lifetime (seconds)")).toHaveValue("3600");
  await expect(page.getByLabel("Capacity (MiB)")).toHaveValue("128");
  await expect(page.getByLabel("Retention (minutes)")).toHaveValue("60");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("Public image origin", { exact: true }).fill("");
  await page.getByLabel("Enable hotlink protection").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved");
});
