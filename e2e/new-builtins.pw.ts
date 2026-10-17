import { test, expect, login } from "./fixtures";

test("new built-ins use the shared source and upload profile forms", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Storage Sources", exact: true })
    .click();
  for (const entry of [
    {
      id: "telegram",
      name: "Telegram form",
      fields: { "Chat ID": "-100123456", "Bot token": "123456:test-token" },
    },
    {
      id: "webdav",
      name: "WebDAV form",
      fields: {
        "WebDAV endpoint": "https://dav.example.com/files/",
        Username: "test-user",
        "Password or app password": "test-password",
      },
    },
    {
      id: "openlist",
      name: "OpenList form",
      fields: {
        Endpoint: "https://openlist.example.com",
        "Mount directory": "/images",
        "API token": "test-token",
      },
    },
  ]) {
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page
      .getByLabel("Plugin", { exact: true })
      .selectOption("builtin." + entry.id + "@1.0.0");
    await page.getByLabel("Source name", { exact: true }).fill(entry.name);
    for (const [label, value] of Object.entries(entry.fields)) {
      await page.getByLabel(label, { exact: true }).fill(value!);
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: entry.name, exact: true }),
    ).toBeVisible();
  }
  const sources = await (
    await page.request.get(service.url + "/api/storage-sources")
  ).json();
  for (const [id, key] of [
    ["telegram", "/botToken"],
    ["webdav", "/password"],
    ["openlist", "/token"],
  ]) {
    const source = sources.find((s: any) => s.pluginId === "builtin." + id);
    expect(source.ready).toBe(true);
    expect(source.secretPresence[key!]).toBe(true);
    expect(JSON.stringify(source.config)).not.toContain("test-token");
    expect(JSON.stringify(source.config)).not.toContain("test-password");
  }
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("builtin.random-path@1.0.0");
  await page.getByLabel("Directory depth", { exact: true }).selectOption("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const detail = await (
    await page.request.get(
      service.url + "/api/upload-profiles/" + profiles[0].id,
    )
  ).json();
  expect(detail.path.pluginId).toBe("builtin.random-path");
  expect(detail.path.config.directoryDepth).toBe(2);
});
