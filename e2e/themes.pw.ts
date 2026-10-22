import { test, expect, login } from "./fixtures";
import { themePackage } from "../tests/theme-fixtures";
const code = `export function mount(el, ctx) {
 const draw = s => { el.replaceChildren(); const h = document.createElement('h1'); h.textContent = ctx.config.heading + ' ' + s.page; el.append(h);
 const input = document.createElement('input'); input.type='file'; input.setAttribute('aria-label','Theme upload'); input.onchange=()=>ctx.uploads.add(Array.from(input.files)); el.append(input);
 const p = document.createElement('p'); p.textContent=s.uploads.map(u=>u.status).join(','); el.append(p);
 const button = document.createElement('button'); button.textContent='Theme login'; button.onclick=()=>ctx.navigate('login'); el.append(button);
 const language = document.createElement('button'); language.textContent='Chinese'; language.onclick=()=>ctx.setLocale('zh-CN'); el.append(language);
 const translated=document.createElement('p'); translated.textContent=ctx.localized(ctx.config.welcome); el.append(translated);
 }; const stop = ctx.subscribe(draw); return {dispose(){stop();el.replaceChildren();}};
}`;

test("theme installation, drafts, preview, full replacement, upload, isolation and recovery", async ({
  page,
  service,
  context,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Themes", exact: true }).click();
  await expect(page.getByLabel("Upload ZIP (up to 20 MB)")).toBeEnabled();
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "theme.zip",
    mimeType: "application/zip",
    buffer: themePackage("1.0.0", code),
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByLabel("heading", { exact: true }).fill("Published");
  await page
    .getByRole("button", { name: "Apply to site", exact: true })
    .click();
  await expect(page.getByText("Theme applied", { exact: true })).toBeVisible();
  await page.getByLabel("heading", { exact: true }).fill("Candidate");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  const previewPromise = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview home", exact: true }).click();
  const preview = await previewPromise;
  await expect(
    preview.getByRole("heading", { name: "Candidate home" }),
  ).toBeVisible();
  await preview.close();
  await page.goto(service.url + "/");
  await expect(
    page.getByRole("heading", { name: "Published home" }),
  ).toBeVisible();
  await page.getByLabel("Theme upload").setInputFiles({
    name: "test.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>',
    ),
  });
  await expect(page.getByText("success", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Theme login" }).click();
  await expect(
    page.getByRole("heading", { name: "Published login" }),
  ).toBeVisible();
  await expect(page.getByText("success", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chinese" }).click();
  await expect(page.getByText("欢迎", { exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("language", "en-US"));
  const themeRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/assets/themes/")) themeRequests.push(req.url());
  });
  await page.goto(service.url + "/app/themes");
  await expect(
    page.getByRole("heading", { name: "Themes", exact: true }),
  ).toBeVisible();
  expect(themeRequests).toEqual([]);
  await page.goto(
    service.url + "/login?theme=default&return=https://evil.invalid",
  );
  await page.getByLabel("Username", { exact: true }).fill("admin");
  await page.getByLabel("Password", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill("test-password-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(service.url + "/app/images");
  expect(themeRequests).toEqual([]);
});

test("default bypass works when theme API fails and broken mount falls back", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const csrf = await page.evaluate(
    async () => (await (await fetch("/api/auth/session")).json()).csrfToken,
  );
  const stageResponse = await page.request.post(
    service.url + "/api/themes/inspect",
    {
      headers: { "X-CSRF-Token": csrf },
      data: themePackage(
        "1.0.0",
        'export function mount(){throw new Error("broken")}',
      ),
    },
  );
  const stage = await stageResponse.json();
  expect(
    (
      await page.request.post(service.url + "/api/themes/install", {
        headers: { "X-CSRF-Token": csrf },
        data: { ticket: stage.ticket, confirmed: true },
      })
    ).ok(),
  ).toBeTruthy();
  await page.request.put(service.url + "/api/theme", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      id: "example.theme",
      version: "1.0.0",
      defaultLocale: "en-US",
      languageRevision: (
        await (await page.request.get(service.url + "/api/themes")).json()
      )[0].languageRevision,
    },
  });
  await page.goto(service.url + "/");
  await expect(
    page.getByRole("button", { name: "Choose files", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Using the default theme.", { exact: false }),
  ).toBeVisible();
  await page.route("**/api/theme", (route) => route.abort());
  await page.goto(service.url + "/login?theme=default");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
});

test("late async mounts are disposed after a page switch", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const csrf = await page.evaluate(
    async () => (await (await fetch("/api/auth/session")).json()).csrfToken,
  );
  const entry = `export async function mount(el, ctx) {
    const page = ctx.getSnapshot().page;
    const title = document.createElement('h1'); title.textContent = page; el.append(title);
    const button = document.createElement('button'); button.textContent='Switch now'; button.onclick=()=>ctx.navigate('login'); el.append(button);
    const stop = ctx.subscribe(()=>{});
    if(page==='home') await new Promise(r=>setTimeout(r,500));
    return {dispose(){stop();window.disposedPage=page;el.replaceChildren();}};
  }`;
  const staged = await (
    await page.request.post(service.url + "/api/themes/inspect", {
      headers: { "X-CSRF-Token": csrf },
      data: themePackage("1.0.0", entry),
    })
  ).json();
  await page.request.post(service.url + "/api/themes/install", {
    headers: { "X-CSRF-Token": csrf },
    data: { ticket: staged.ticket, confirmed: true },
  });
  await page.request.put(service.url + "/api/theme", {
    headers: { "X-CSRF-Token": csrf },
    data: {
      id: "example.theme",
      version: "1.0.0",
      defaultLocale: "en-US",
      languageRevision: (
        await (await page.request.get(service.url + "/api/themes")).json()
      )[0].languageRevision,
    },
  });
  await page.goto(service.url + "/");
  await page.getByRole("button", { name: "Switch now" }).click();
  await expect(
    page.getByRole("heading", { name: "login", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).disposedPage))
    .toBe("home");
  await expect(page.getByRole("heading")).toHaveCount(1);
});

test("language editor retains empty translations and preview default does not change the site", async ({
  page,
  service,
  context,
}) => {
  await login(page, service.url);
  await page.goto(service.url + "/app/themes");
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "theme.zip",
    mimeType: "application/zip",
    buffer: themePackage(
      "1.0.0",
      `export function mount(el,ctx){const s=ctx.getSnapshot();el.textContent=s.locale+'|'+ctx.localized(ctx.config.welcome);return {dispose(){}}}`,
    ),
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Content language", exact: true }),
  ).toHaveCount(0);
  const welcome = page.getByLabel("welcome · English", { exact: true });
  await welcome.fill("");
  const editTranslations = page.getByRole("button", {
    name: "Edit translations · welcome",
    exact: true,
  });
  await editTranslations.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("English", { exact: true }).fill("Discard this");
  await dialog.getByLabel("简体中文", { exact: true }).fill("取消的翻译");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(welcome).toHaveValue("");
  await editTranslations.click();
  await expect(dialog.getByLabel("English", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("简体中文", { exact: true })).not.toHaveValue(
    "取消的翻译",
  );
  await dialog.getByLabel("简体中文", { exact: true }).fill("新的欢迎");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(welcome).toHaveValue("");
  await page
    .getByRole("combobox", { name: "Default language", exact: true })
    .selectOption("zh-CN");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  expect(
    (
      await (
        await page.request.get(service.url + "/api/client-settings")
      ).json()
    ).defaultLocale,
  ).toBe("en-US");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview home", exact: true }).click();
  const preview = await opened;
  await expect(preview.locator("body")).toContainText("zh-CN|新的欢迎");
  expect(
    await preview.evaluate(() => localStorage.getItem("language")),
  ).not.toBe("zh-CN");
  await preview.close();
  await page
    .getByRole("button", { name: "Apply to site", exact: true })
    .click();
  await expect(page.getByText("Theme applied", { exact: true })).toBeVisible();
  expect(
    (
      await (
        await page.request.get(service.url + "/api/client-settings")
      ).json()
    ).defaultLocale,
  ).toBe("zh-CN");
  await page.reload();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit translations · welcome", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("English", { exact: true }),
  ).toHaveValue("");
});

test("single-language page constrains SDK choices without overwriting visitor preference", async ({
  page,
  service,
}) => {
  const { zip } = await import("../tests/package-fixtures");
  await login(page, service.url);
  const csrf = await page.evaluate(
    async () => (await (await fetch("/api/auth/session")).json()).csrfToken,
  );
  const headers = { "X-CSRF-Token": csrf };
  const entry = `export function mount(el,ctx){const s=ctx.getSnapshot();const h=document.createElement('h1');h.textContent=s.locale+'|'+s.locales.join(',');el.append(h);const b=document.createElement('button');b.textContent='Invalid language';b.onclick=()=>{try{ctx.setLocale('zh-CN')}catch{b.textContent='Rejected'}};el.append(b);const login=document.createElement('button');login.textContent='Open login';login.onclick=()=>ctx.navigate('login');el.append(login);return {dispose(){}}}`;
  const data = zip({
    "theme.json": JSON.stringify({
      id: "single.theme",
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Single" } },
      version: "1",
      apiVersion: 1,
      supportedLocales: ["en-US"],
      pages: { home: { entry: "entry.js" } },
    }),
    "entry.js": entry,
  });
  const stage = await (
    await page.request.post(service.url + "/api/themes/inspect", {
      headers,
      data,
    })
  ).json();
  await page.request.post(service.url + "/api/themes/install", {
    headers,
    data: { ticket: stage.ticket, confirmed: true },
  });
  const installed = await (
    await page.request.get(service.url + "/api/themes")
  ).json();
  expect(
    (
      await page.request.put(service.url + "/api/theme", {
        headers,
        data: {
          id: "single.theme",
          version: "1",
          defaultLocale: "en-US",
          languageRevision: installed[0].languageRevision,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.evaluate(() => localStorage.setItem("language", "zh-CN"));
  await page.goto(service.url + "/");
  await expect(
    page.getByRole("heading", { name: "en-US|en-US", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Invalid language", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rejected", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("language"))).toBe(
    "zh-CN",
  );
  await page.getByRole("button", { name: "Open login", exact: true }).click();
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("incomplete theme preview reports validation failure instead of mounting a fallback page", async ({
  page,
  service,
  context,
}) => {
  const { zip } = await import("../tests/package-fixtures");
  await login(page, service.url);
  await page.goto(service.url + "/app/themes");
  const buffer = zip({
    "theme.json": JSON.stringify({
      id: "required.preview",
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Required preview" } },
      version: "1",
      apiVersion: 1,
      supportedLocales: ["en-US"],
      pages: { home: { entry: "entry.js" } },
      configSchema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 2 } },
      },
    }),
    "entry.js":
      "export function mount(el,ctx){el.textContent=ctx.config.title;return {dispose(){}}}",
  });
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "required.zip",
    mimeType: "application/zip",
    buffer,
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview home", exact: true }).click();
  const preview = await opened;
  await expect(preview.getByRole("alert")).toContainText("config/title");
  await expect(preview.locator("input")).toHaveCount(0);
  await preview.close();
  await page.getByLabel("title", { exact: true }).fill("Ready");
  await page
    .getByRole("button", { name: "Apply to site", exact: true })
    .click();
  await expect(page.getByText("Theme applied", { exact: true })).toBeVisible();
  await page.goto(service.url + "/");
  await expect(page.locator("body")).toContainText("Ready");
});

test("theme package default localizes one name and labels without filling config values", async ({
  page,
  service,
  context,
}) => {
  const { zip } = await import("../tests/package-fixtures");
  await login(page, service.url);
  await page.goto(service.url + "/app/themes");
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "localized.zip",
    mimeType: "application/zip",
    buffer: zip({
      "theme.json": JSON.stringify({
        id: "localized.theme",
        version: "1",
        apiVersion: 1,
        defaultLocale: "en-US",
        supportedLocales: ["en-US", "zh-CN"],
        nameKey: "package.name",
        messages: {
          "en-US": {
            "package.name": "Horizon",
            action: "Upload now",
            "heading.label": "Hero heading",
          },
          "zh-CN": { "package.name": "远空" },
        },
        pages: { home: { entry: "entry.js" } },
        configSchema: {
          type: "object",
          properties: {
            heading: {
              type: "string",
              "x-localized": true,
              default: { "en-US": "Welcome", "zh-CN": "" },
              "x-ui": { labelKey: "heading.label" },
            },
          },
        },
      }),
      "entry.js": `export function mount(el,ctx){el.textContent=ctx.t('action')+'|'+ctx.localized(ctx.config.heading)+'|'+ctx.t('toString');return {dispose(){}}}`,
    }),
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.locator("fieldset.panel > h2")).toHaveText("Horizon · 1");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(page.locator("fieldset.panel > h2")).toHaveText("远空 · 1");
  await expect(
    page.getByLabel("Hero heading · English", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en-US");
  await expect(page.locator("fieldset.panel > h2")).toHaveText("Horizon · 1");
  await page
    .getByRole("button", {
      name: "Edit translations · Hero heading",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("简体中文", { exact: true }),
  ).toHaveValue("");
  await page.keyboard.press("Escape");
  await page
    .getByRole("combobox", { name: "Default language", exact: true })
    .selectOption("zh-CN");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview home", exact: true }).click();
  const preview = await opened;
  await expect(preview.locator("#app")).toContainText("Upload now||toString");
  await expect(preview.locator("#app")).not.toContainText("Welcome");
  await preview.close();
});

test("theme fields preserve removals, empty text and other languages after saving and previewing", async ({
  page,
  service,
  context,
}) => {
  const { zip } = await import("../tests/package-fixtures");
  await login(page, service.url);
  await page.goto(service.url + "/app/themes");
  const manifest = {
    id: "removal.theme",
    version: "1",
    apiVersion: 1,
    nameKey: "name",
    defaultLocale: "en-US",
    supportedLocales: ["en-US", "zh-CN"],
    messages: { "en-US": { name: "Removal" } },
    pages: { home: { entry: "entry.js" } },
    configSchema: {
      type: "object",
      properties: {
        count: { type: "integer", minimum: 1, default: 3 },
        mode: { type: "string", enum: ["a", "b"], default: "a" },
        enabled: { type: "boolean", default: true },
        heading: { type: "string", default: "Original" },
        welcome: {
          type: "string",
          "x-localized": true,
          default: { "en-US": "Hello", "zh-CN": "欢迎" },
        },
        group: {
          type: "object",
          properties: {
            ordinary: { type: "string", default: "ordinary" },
            translated: {
              type: "string",
              "x-localized": true,
              default: { "en-US": "Group", "zh-CN": "分组" },
            },
          },
        },
      },
    },
  };
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "removal.zip",
    mimeType: "application/zip",
    buffer: zip({
      "theme.json": JSON.stringify(manifest),
      "entry.js":
        "export function mount(el,ctx){el.dataset.testid='config-output';el.textContent=JSON.stringify(ctx.config);return {dispose(){}}}",
    }),
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByLabel("count", { exact: true }).fill("");
  await page.getByLabel("mode", { exact: true }).selectOption("__unset");
  await page
    .getByLabel("enabled", { exact: true })
    .locator("..")
    .getByRole("button", { name: "Remove field", exact: true })
    .click();
  await page.getByLabel("heading", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Edit translations · welcome", exact: true })
    .click();
  const translations = page.getByRole("dialog");
  await translations
    .getByLabel("English", { exact: true })
    .locator("..")
    .getByRole("button", { name: "Remove field", exact: true })
    .click();
  await translations
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page
    .getByText("group", { exact: true })
    .locator("..")
    .getByRole("button", { name: "Remove field", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const expected = { heading: "", welcome: { "zh-CN": "欢迎" } };
  const installed = await (
    await page.request.get(service.url + "/api/themes")
  ).json();
  expect(installed[0].config).toEqual(expected);
  await page.reload();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByLabel("count", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("mode", { exact: true })).toHaveValue("__unset");
  await page
    .getByRole("button", { name: "Edit translations · welcome", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByLabel("简体中文", { exact: true }),
  ).toHaveValue("欢迎");
  await page.keyboard.press("Escape");
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Preview home", exact: true }).click();
  const preview = await opened;
  await expect(preview.getByTestId("config-output")).toHaveText(
    JSON.stringify(expected),
  );
  await preview.close();
});

test("theme configuration sessions reset pending array drafts and translation dialogs preserve them", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.route("**/api/themes", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        ["First", "Second"].map((name) => ({
          manifest: {
            id: name.toLowerCase() + ".theme",
            version: "1",
            defaultLocale: "en-US",
            supportedLocales: ["en-US", "zh-CN"],
            nameKey: "name",
            messages: { "en-US": { name } },
            configSchema: {
              type: "object",
              properties: {
                rows: {
                  type: "array",
                  items: { type: "string", "x-localized": true },
                },
              },
            },
          },
          compatible: true,
          config: { rows: [] },
          enabledLocales: ["en-US", "zh-CN"],
          siteDefaultLocale: "en-US",
        })),
      ),
    }),
  );
  await page.goto(service.url + "/app/themes");
  const configure = page.getByRole("button", {
    name: "Configure",
    exact: true,
  });
  const add = page.getByRole("button", { name: "Add item", exact: true });
  const draft = page.getByRole("textbox", {
    name: "New item · English",
    exact: true,
  });
  await configure.nth(0).click();
  await add.click();
  await draft.fill("English draft");
  await page
    .getByRole("button", { name: "Edit translations · New item", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("简体中文", { exact: true })).toHaveValue("");
  await dialog.getByLabel("简体中文", { exact: true }).fill("中文草稿");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(draft).toHaveValue("English draft");
  await page
    .getByRole("button", { name: "Edit translations · New item", exact: true })
    .click();
  await expect(dialog.getByLabel("简体中文", { exact: true })).toHaveValue(
    "中文草稿",
  );
  await page.keyboard.press("Escape");

  await configure.nth(1).click();
  await expect(draft).toHaveCount(0);
  await add.click();
  await expect(draft).toHaveValue("");
  await draft.fill("Second theme draft");
  await configure.nth(1).click();
  await expect(draft).toHaveCount(0);
  await add.click();
  await expect(draft).toHaveValue("");
});

test("localized arrays have one structure and persist edits without language fallback", async ({
  page,
  service,
}) => {
  const { zip } = await import("../tests/package-fixtures");
  await login(page, service.url);
  await page.getByRole("link", { name: "Themes", exact: true }).click();
  await expect(page.getByLabel("Upload ZIP (up to 20 MB)")).toBeEnabled();
  await page.getByLabel("Upload ZIP (up to 20 MB)").setInputFiles({
    name: "array-theme.zip",
    mimeType: "application/zip",
    buffer: zip({
      "theme.json": JSON.stringify({
        id: "test.arrays",
        version: "1",
        apiVersion: 1,
        defaultLocale: "en-US",
        supportedLocales: ["en-US", "zh-CN"],
        nameKey: "name",
        messages: { "en-US": { name: "Arrays" } },
        pages: { home: { entry: "entry.js" } },
        configSchema: {
          type: "object",
          properties: {
            choice: {
              type: "object",
              properties: { a: { type: "integer" }, b: { type: "integer" } },
              enum: [
                { a: 1, b: 2 },
                { a: 3, b: 4 },
              ],
              default: { b: 2, a: 1 },
            },
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", "x-localized": true },
                  url: { type: "string" },
                },
              },
            },
          },
        },
      }),
      "entry.js": "export function mount(){return {dispose(){}}}",
    }),
  });
  await page
    .getByLabel("I trust this theme and its access to login credentials.")
    .check();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await expect(page.getByLabel("choice", { exact: true })).toHaveValue(
    JSON.stringify({ a: 1, b: 2 }),
  );
  await page
    .getByLabel("choice", { exact: true })
    .selectOption(JSON.stringify({ a: 3, b: 4 }));
  await expect(
    page.getByRole("button", { name: "Add item", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("title · English", { exact: true }).fill("English");
  await page.getByLabel("url", { exact: true }).fill("/one");
  await page
    .getByRole("button", { name: "Edit translations · title", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("简体中文", { exact: true })).toHaveValue("");
  await dialog.getByLabel("简体中文", { exact: true }).fill("中文");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByLabel("url", { exact: true })).toHaveValue("/one");
  await expect(page.getByLabel("title · English", { exact: true })).toHaveValue(
    "English",
  );
  await page.getByRole("button", { name: "Add item", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit translations · title", exact: true })
    .nth(1)
    .click();
  await dialog.getByLabel("简体中文", { exact: true }).fill("第二项");
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Move item up", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
  const themes = await (
    await page.request.get(service.url + "/api/themes")
  ).json();
  const config = themes.find(
    (theme: any) => theme.manifest.id === "test.arrays",
  ).config;
  expect(config.choice).toEqual({ a: 3, b: 4 });
  expect(config.rows).toEqual([
    { title: { "zh-CN": "第二项" } },
    { title: { "en-US": "English", "zh-CN": "中文" }, url: "/one" },
  ]);
});
