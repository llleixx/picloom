import { test, expect, login, expandDetails } from "./fixtures";
test.use({ scenario: "seed" });
test("shared access parameters ignore presentation hints but retain constraint conflicts", async ({
  page,
  service,
}) => {
  await page.route("**/api/access-parameters", (route) =>
    route.fulfill({
      json: [0, 1].map((index) => ({
        id: `step${index}`,
        plugin: {
          id: `plugin${index}`,
          defaultLocale: "en-US",
          nameKey: "name",
          messages: { "en-US": { name: `Processor ${index}` } },
        },
        defaultLocale: "en-US",
        messages: {
          "en-US": { [`width${index}`]: `Width ${index}`, quality: "Quality" },
        },
        paramsSchema: {
          type: "object",
          properties: {
            w: {
              type: "integer",
              minimum: 1,
              "x-ui": { labelKey: `width${index}`, order: index },
            },
            q: {
              type: "integer",
              maximum: index ? 80 : 100,
              "x-ui": { labelKey: "quality" },
            },
          },
        },
      })),
    }),
  );
  await login(page, service.url);
  await page
    .getByRole("button", { name: /^Open / })
    .first()
    .click();
  await expandDetails(page, "link-parameters");
  await page
    .getByRole("button", { name: "Add parameter", exact: true })
    .click();
  const width = page.getByRole("button", { name: /Width 0/ }).first();
  await expect(width).toBeEnabled();
  await expect(
    page
      .getByRole("button", { name: /Quality.*Conflicting definitions/ })
      .first(),
  ).toBeDisabled();
  await width.click();
  await page.getByLabel("Width 0", { exact: true }).fill("12");
  await expect(page.getByLabel("Width 0", { exact: true })).toHaveValue("12");
  const plugin = page.getByRole("combobox", { name: "Plugin", exact: true });
  await plugin.click();
  await plugin.fill("step1");
  await page.getByRole("option", { name: /step1/ }).click();
  await expect(page.getByLabel("Width 0", { exact: true })).toHaveValue("12");
  await expect(page.getByText("Also used by: step0")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open link", exact: true }),
  ).toHaveAttribute("href", /w=12/);
  await plugin.click();
  await page.getByRole("option", { name: /Added parameters/ }).click();
  await expect(page.getByLabel("Width 0", { exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Add parameter", exact: true }),
  ).toHaveCount(0);
});

test("access links preserve empty, false and zero and do not pick conflicting defaults", async ({
  page,
  service,
}) => {
  await page.route("**/api/access-parameters", (route) =>
    route.fulfill({
      json: [1, 2].map((index) => ({
        id: String(index),
        plugin: { id: "test" },
        defaultLocale: "en-US",
        messages: { "en-US": {} },
        paramsSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            toString: { type: "string" },
            flag: { type: "boolean" },
            count: { type: "integer", default: 0 },
            choice: { type: "integer", default: index },
          },
        },
      })),
    }),
  );
  await login(page, service.url);
  await page
    .getByRole("button", { name: /^Open / })
    .first()
    .click();
  await expandDetails(page, "link-parameters");
  async function add(key: string) {
    await page
      .getByRole("button", { name: "Add parameter", exact: true })
      .click();
    await page
      .getByRole("button", { name: new RegExp("^" + key + "\\s+" + key + "$") })
      .first()
      .click();
  }
  await add("flag");
  await add("toString");
  await expect(page.getByLabel("toString", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("flag", { exact: true })).toHaveValue("__unset");
  await page.getByLabel("flag", { exact: true }).selectOption("false");
  await add("text");
  await page.getByLabel("text", { exact: true }).fill("temporary");
  await expect(
    page.getByRole("link", { name: "Open link", exact: true }),
  ).toHaveAttribute("href", /text=temporary/);
  await page.getByLabel("text", { exact: true }).fill("");
  await expect(
    page.getByRole("link", { name: "Open link", exact: true }),
  ).toHaveAttribute("href", /text=(?:&|$)/);
  await add("count");
  await expect(page.getByLabel("count", { exact: true })).toHaveValue("0");
  await add("choice");
  await expect(
    page.getByText("Default values differ; enter a value explicitly."),
  ).toBeVisible();
  await expect(page.getByLabel("choice", { exact: true })).toHaveValue("");
  const href = await page
    .getByRole("link", { name: "Open link", exact: true })
    .getAttribute("href");
  const params = new URL(href!).searchParams;
  expect(params.get("flag")).toBe("false");
  expect(params.get("text")).toBe("");
  expect(params.get("count")).toBe("0");
  expect(params.has("choice")).toBe(false);
  expect(params.has("toString")).toBe(false);
});
