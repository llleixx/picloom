import { test, expect, login } from "./fixtures";
import sharp from "sharp";
test("source filter, replica deletion and explicit last-copy deletion", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "x-csrf-token": session.csrfToken, origin: service.url };
  const source = await (
    await page.request.post(service.url + "/api/storage-sources", {
      headers,
      data: {
        pluginId: "builtin.local",
        version: "1.0.0",
        name: "Extra copy",
        config: { root: service.root + "/extra" },
        secretEdits: {},
      },
    })
  ).json();
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const profile = await (
    await page.request.get(
      service.url + "/api/upload-profiles/" + profiles[0].id,
    )
  ).json();
  const group = await (
    await page.request.get(
      service.url + "/api/storage-groups/" + profile.storageGroupId,
    )
  ).json();
  expect(
    (
      await page.request.put(service.url + "/api/storage-groups/" + group.id, {
        headers,
        data: {
          ...group,
          members: [...group.members, { instanceId: source.id, weight: 1 }],
          replicaCount: 2,
          expectedVersion: group.configVersion,
        },
      })
    ).ok(),
  ).toBeTruthy();
  const bytes = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const image = await (
    await page.request.post(service.url + "/api/files", {
      headers,
      multipart: {
        profileId: profile.id,
        file: { name: "sample.png", mimeType: "image/png", buffer: bytes },
      },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `${service.url}/api/files/${image.id}/operations`,
            )
          ).json()
        ).replicas.filter((r: any) => r.status === "ready").length,
    )
    .toBe(2);
  await page.reload();
  await page
    .getByLabel("Storage Source", { exact: true })
    .selectOption(source.id);
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Storage Source", { exact: true })).toHaveValue(
    source.id,
  );
  await page
    .getByTestId("file-card")
    .getByRole("button", { name: /^Open / })
    .click();
  const row = page
    .locator("div.rounded-lg.border.p-3")
    .filter({ hasText: "Extra copy" })
    .first();
  await row.getByRole("button", { name: "Delete Replica" }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(row).toContainText("Deleted");
  expect(
    (await page.request.get(service.url + new URL(image.url).pathname)).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  await page
    .getByLabel("Storage Source", { exact: true })
    .selectOption(group.members[0].instanceId);
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.getByTestId("file-card").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox")).toHaveValue("false");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  expect(
    (
      await page.request.get(service.url + new URL(image.url).pathname)
    ).status(),
  ).toBe(404);
});
