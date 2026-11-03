import { test, expect, login } from "./fixtures";

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
  await page.goto(service.url + "/app/system?view=system");
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
