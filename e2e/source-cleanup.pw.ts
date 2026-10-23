import { test, expect, login, type Service } from "./fixtures";
import type { Page } from "@playwright/test";
import sharp from "sharp";
async function prepare(page: Page, service: Service) {
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
        name: "Retiring source",
        config: { root: service.root + "/retiring" },
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
          members: [{ instanceId: source.id, weight: 1 }],
          replicaCount: 1,
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
        file: { name: "retire.png", mimeType: "image/png", buffer: bytes },
      },
    })
  ).json();
  const remove = async () => {
    const latest = await (
      await page.request.get(service.url + "/api/storage-groups/" + group.id)
    ).json();
    expect(
      (
        await page.request.put(
          service.url + "/api/storage-groups/" + group.id,
          {
            headers,
            data: { ...group, expectedVersion: latest.configVersion },
          },
        )
      ).ok(),
    ).toBeTruthy();
  };
  const open = async () => {
    await page.goto(service.url + "/app/config/sources");
    await page
      .locator("article")
      .filter({
        has: page.getByRole("heading", { name: source.name, exact: true }),
      })
      .getByRole("button", { name: "Clean up images", exact: true })
      .click();
    return page.getByRole("dialog");
  };
  return { source, image, group, headers, open, remove };
}
test.describe("cleanup restoration", () => {
  test.use({ scenario: "cleanup-restore" });
  test("source cleanup defaults, group editor link, and persisted progress after reload and restart", async ({
    page,
    service,
  }) => {
    const state = await prepare(page, service);
    let panel = await state.open();
    await expect(
      panel.getByRole("button", { name: "Start cleanup" }),
    ).toBeDisabled();
    await panel
      .getByRole("link", { name: state.group.name, exact: true })
      .click();
    await expect(page).toHaveURL(/\/app\/config\/groups\?edit=/);
    await expect(
      page.getByRole("dialog").getByRole("textbox").first(),
    ).toHaveValue(state.group.name);
    await state.remove();
    panel = await state.open();
    await expect(panel.getByLabel("Operation")).toHaveValue("delete");
    await expect(panel.getByRole("checkbox")).not.toBeChecked();
    await expect(panel).toContainText(
      "1 replicas; 1 have no other available replica",
    );
    await service.restart();
    panel = await state.open();
    await panel.getByLabel("Operation").selectOption("detach");
    await panel.getByRole("checkbox").check();
    const accepted = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/storage-sources/${state.source.id}/cleanups`) &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "Start cleanup" }).click();
    const response = await accepted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toMatchObject({
      mode: "detach",
      includeLast: false,
    });
    await service.restart();
    panel = await state.open();
    await expect(panel.getByLabel("Operation")).toHaveValue("detach");
    await expect(panel.getByLabel("Operation")).toBeDisabled();
    await expect(panel.getByRole("checkbox")).toBeChecked();
    await expect(panel.getByRole("checkbox")).toBeDisabled();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .locator("article")
      .filter({
        has: page.getByRole("heading", {
          name: state.source.name,
          exact: true,
        }),
      })
      .getByRole("button", { name: "Clean up images", exact: true })
      .click();
    panel = page.getByRole("dialog");
    await expect(panel.getByLabel("Operation")).toHaveValue("detach");
    await expect(panel.getByRole("checkbox")).toBeChecked();
    await expect(panel).toContainText("Cleanup job finished");
    await expect(panel).toContainText("Kept: 1");
    await expect(panel.getByLabel("Operation")).toBeEnabled();
    await panel.getByRole("checkbox").uncheck();
    await panel
      .getByRole("button", { name: "Start cleanup", exact: true })
      .click();
    await expect(panel).toContainText("Completed: 1");
    await expect(panel).toContainText("Remaining source references: 0");
    await expect(
      panel.getByRole("button", { name: "Delete source configuration…" }),
    ).toBeVisible();
    expect(
      (
        await page.request.get(service.url + new URL(state.image.url).pathname)
      ).status(),
    ).toBe(404);
  });
});
test.describe("failed cleanup", () => {
  test.use({ scenario: "delete-failure" });
  test("reload shows failed results; retry reuses tasks and a new detach cleanup finishes", async ({
    page,
    service,
  }) => {
    const state = await prepare(page, service);
    await state.remove();
    let panel = await state.open();
    await panel.getByRole("button", { name: "Start cleanup" }).click();
    await expect(panel).toContainText("Failed: 1");
    const before = await (
      await page.request.get(
        `${service.url}/api/files/${state.image.id}/operations`,
      )
    ).json();
    const task = before.tasks.find(
      (task: { kind: string }) => task.kind === "delete",
    );
    await page.reload();
    await page
      .locator("article")
      .filter({ hasText: "Retiring source" })
      .getByRole("button", { name: "Clean up images", exact: true })
      .click();
    panel = page.getByRole("dialog");
    await expect(panel).toContainText("Failed: 1");
    await panel.getByRole("button", { name: "Retry failed items" }).click();
    await expect
      .poll(async () => {
        const operations = await (
          await page.request.get(
            `${service.url}/api/files/${state.image.id}/operations`,
          )
        ).json();
        return operations.tasks.find(
          (item: { id: string }) => item.id === task.id,
        )?.attempts;
      })
      .toBe(2);
    await expect(panel).toContainText("Failed: 1");
    await panel.getByLabel("Operation").selectOption("detach");
    await panel.getByRole("button", { name: "Start cleanup" }).click();
    await expect(panel).toContainText("Completed: 1");
    await expect(panel).toContainText("Remaining source references: 0");
  });
});
