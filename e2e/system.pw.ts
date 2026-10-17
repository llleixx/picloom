import { test, expect, login } from "./fixtures";

test("system status shows usage, supports deep links and mobile navigation", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "System", exact: true }).click();
  await expect(page).toHaveURL(/app\/system$/);
  await expect(
    page.getByRole("heading", { name: "System", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("ready-images")).toHaveText("0");
  await expect(page.getByTestId("usage-diskTotal")).not.toHaveText(
    /Calculating|Unavailable/,
  );
  await expect(
    page.getByText("No failed tasks", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear derived cache", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Clear derived cache", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Clear derived cache", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Derived cache cleared", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Local storage", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("link", { name: "System", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "System", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("PostgreSQL hides backup actions without requesting the backup list", async ({
  page,
  service,
}) => {
  await page.route("**/api/system/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), database: "postgres" },
    });
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/system/backups"))
      requests.push(request.url());
  });
  await login(page, service.url);
  await page.goto(service.url + "/app/system");
  await expect(
    page.getByText("Backup and restore are unavailable for PostgreSQL.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create Backup", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Restore Backup", exact: true }),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});
