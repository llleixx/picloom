import { test, expect, login } from "./fixtures";

test("user and guest upload limits can be configured from the web", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/app/users");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("limited");
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByLabel("Maximum File Size (MiB)", { exact: true }).fill("2");
  await page.getByLabel("Daily Upload Limit", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const users = await (
    await page.request.get(service.url + "/api/users")
  ).json();
  expect(users.items.find((u: any) => u.username === "limited")).toMatchObject({
    maxUploadBytes: 2097152,
    dailyUploadLimit: 5,
  });
  await page.goto(service.url + "/app/settings");
  await page.getByLabel("Maximum File Size (MiB)", { exact: true }).fill("1");
  await page.getByLabel("Daily Upload Limit", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(service.url + "/api/settings")).json())
          .guestDailyUploadLimit,
    )
    .toBe(0);
  await page.reload();
  await expect(
    page.getByLabel("Maximum File Size (MiB)", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page.getByLabel("Daily Upload Limit", { exact: true }),
  ).toHaveValue("0");
  await page.getByLabel("Daily Upload Limit", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(service.url + "/api/settings")).json())
          .guestDailyUploadLimit,
    )
    .toBeNull();
});
