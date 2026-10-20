import { test, expect } from "./fixtures";

test.use({ locale: "zh-CN" });

test("Chinese default, persisted switch, and live plugin fields preserve drafts", async ({
  page,
  service,
  context,
}) => {
  await page.goto(service.url);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(
    page.locator('select[aria-label="语言"] option[value=""]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "上传、复制、分享。", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "登录", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "图片", exact: true }),
  ).toBeVisible();
  // Route links remain discoverable in the selected language.
  await page.getByRole("link", { name: "存储源", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page
    .getByLabel("插件", { exact: true })
    .selectOption("builtin.local@1.0.0");
  await page.getByLabel("存储源名称").fill("我的 Gallery");
  await page
    .getByLabel("根目录", { exact: false })
    .fill(service.root + "/draft");
  // A second tab changes the preference while this tab keeps an unsaved form open.
  const other = await context.newPage();
  await other.goto(service.url);
  await other.getByLabel("语言", { exact: true }).selectOption("en-US");
  await expect(page.getByLabel("Source name")).toHaveValue("我的 Gallery");
  await expect(page.getByLabel("Root directory", { exact: false })).toHaveValue(
    service.root + "/draft",
  );
  await expect(page.getByLabel("Plugin", { exact: true })).toHaveValue(
    "builtin.local@1.0.0",
  );
  await expect(
    page.getByLabel("Plugin", { exact: true }).locator("option:checked"),
  ).toContainText("Local Storage");
  await other.reload();
  await expect(other.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(
    other.getByRole("heading", { name: "Upload. Copy. Share.", exact: true }),
  ).toBeVisible();
  await other.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await expect(page.getByLabel("存储源名称")).toHaveValue("我的 Gallery");
  await expect(page.getByLabel("根目录", { exact: false })).toHaveValue(
    service.root + "/draft",
  );
  await expect(
    page.getByLabel("插件", { exact: true }).locator("option:checked"),
  ).toContainText("本地存储");
  await page.screenshot({ path: "outputs/chinese-storage-draft.png" });
  await other.close();
});

test("localized site settings preserve drafts and homepage restrictions preserve preferences", async ({
  page,
  service,
}) => {
  await page.goto(service.url + "/login");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/images/);
  await page.goto(service.url + "/app/settings");
  await page
    .getByLabel("正在编辑的内容语言", { exact: true })
    .selectOption("zh-CN");
  await page.getByRole("textbox", { name: /^站点名称 · / }).fill("拾光图床");
  await page.getByRole("textbox", { name: /^站点简介 · / }).fill("中文介绍");
  await page.getByLabel("默认语言", { exact: true }).selectOption("zh-CN");
  await page
    .getByLabel("正在编辑的内容语言", { exact: true })
    .selectOption("en-US");
  await page
    .getByRole("textbox", { name: /^站点简介 · / })
    .fill("English introduction");
  await page
    .getByLabel("正在编辑的内容语言", { exact: true })
    .selectOption("zh-CN");
  await expect(page.getByRole("textbox", { name: /^站点名称 · / })).toHaveValue(
    "拾光图床",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page).toHaveTitle(/拾光图床/);
  await page.goto(service.url);
  await page.getByLabel("语言", { exact: true }).selectOption("en-US");
  await expect(
    page.getByRole("heading", { name: "拾光图床", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("English introduction", { exact: true }),
  ).toBeVisible();
  await page.goto(service.url + "/app/settings");
  await page.getByRole("checkbox", { name: "English", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await page.goto(service.url);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByLabel("语言", { exact: true })).toHaveCount(0);
  await expect(page.getByText("中文介绍", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("language"))).toBe(
    "en-US",
  );
  await page.goto(service.url + "/app/settings");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page
    .getByLabel("Content language", { exact: true })
    .selectOption("en-US");
  await expect(
    page.getByRole("textbox", { name: /^Short description · / }),
  ).toHaveValue("English introduction");
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "English", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "English", exact: true }).check();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await (await saved).json()).enabledLocales).toEqual([
    "zh-CN",
    "en-US",
  ]);
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "English", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "简体中文", exact: true }),
  ).toBeChecked();
});
