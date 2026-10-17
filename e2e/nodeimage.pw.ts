import { test, expect, login } from "./fixtures";
test("NodeImage storage source form saves an encrypted API key and read mode", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Storage Sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Plugin", { exact: true })
    .selectOption("builtin.nodeimage@1.0.0");
  await page.getByLabel("Source name", { exact: true }).fill("NodeImage test");
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.getByLabel("API key", { exact: true }).fill("test-api-key");
  await expect(
    page.getByLabel("Redirect reads (302)", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const sources = await (
    await page.request.get(service.url + "/api/storage-sources")
  ).json();
  const source = sources.find((s: any) => s.name === "NodeImage test");
  expect(source.ready).toBe(true);
  expect(source.secretPresence["/apiKey"]).toBe(true);
  expect(source.config.apiKey).toBeUndefined();
});
