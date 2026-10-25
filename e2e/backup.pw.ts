import { test, expect, login } from "./fixtures";
test.use({ scenario: "backup" });
test("Owner creates, downloads, uploads and restores a backup through System", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/app/system?view=system");
  await page
    .getByRole("button", { name: "Create Backup", exact: true })
    .click();
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await expect(restore).toHaveCount(1);
  await expect(restore).toBeEnabled();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download", exact: true }).click();
  const download = await downloadEvent;
  const archive = await download.path();
  expect(archive).toBeTruthy();
  await page
    .getByLabel("Restore Backup", { exact: true })
    .setInputFiles(archive!);
  await expect(restore).toHaveCount(2);
  await expect(restore.first()).toBeEnabled();
  const remove = page.getByRole("button", { name: "Delete", exact: true });
  await remove.first().click();
  await expect(page.getByRole("dialog")).toContainText(
    "Current site data is unaffected",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(restore).toHaveCount(2);
  await remove.first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(restore).toHaveCount(1);
  await restore.first().click();
  await expect(page.getByRole("dialog")).toContainText("Replace current data");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restore", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, service.url);
  await service.restart();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Images", exact: true }),
  ).toBeVisible();
});
