import { test, expect, login } from "./fixtures";
import { zip } from "../tests/package-fixtures";

test("external versions coexist; preview can be cancelled, completed and old version uninstalled", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "x-csrf-token": session.csrfToken };
  for (const version of ["1.0.0", "2.0.0", "3.0.0"]) {
    const manifest = {
      id: "example.upgrade-path",
      version,
      kind: "path",
      apiVersion: 1,
      entry: "index.js",
    };
    const schema = {
      type: "object",
      properties:
        version === "1.0.0"
          ? {}
          : {
              folder: {
                "x-ui": { labelKey: "settings.folder.label" },
                type: "string",
                minLength: 1,
              },
            },
      required: version === "1.0.0" ? [] : ["folder"],
      additionalProperties: false,
    };
    const code = `export default { ...${JSON.stringify(manifest)}, defaultLocale:"en-US",nameKey:"package.name",messages:{"en-US":{"package.name":"Upgrade path","settings.folder.label":"Folder"}}, configSchemaVersion:${version === "1.0.0" ? 1 : 2}, configSchema:${JSON.stringify(schema)}, async createInstance({config}) { return { async generate({fileId}) { return {logicalKey:(config.folder ? config.folder+'/' : '')+fileId+'.png'} } } } }`;
    const bytes = zip({
      "plugin.json": JSON.stringify(manifest),
      "index.js": code,
    });
    const inspection = await page.request.post(
      service.url + "/api/plugins/inspect",
      {
        headers,
        multipart: {
          file: {
            name: "plugin.zip",
            mimeType: "application/zip",
            buffer: bytes,
          },
        },
      },
    );
    expect(inspection.status()).toBe(200);
    const { ticket } = await inspection.json();
    expect(
      (
        await page.request.post(service.url + "/api/plugins/install", {
          headers,
          data: { ticket, confirmTrusted: true },
        })
      ).status(),
    ).toBe(201);
  }
  await page.goto(service.url + "/app/config/profiles");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("example.upgrade-path@1.0.0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const detail = () =>
    page.request
      .get(service.url + "/api/upload-profiles/" + profiles[0].id)
      .then((r) => r.json());
  const old = await detail();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page
    .getByRole("combobox", { name: /^Target version/ })
    .selectOption("2.0.0");
  let previewAttempts = 0;
  await page.route(
    "**/api/plugin-configurations/*/upgrade-preview",
    async (route) => {
      previewAttempts++;
      if (previewAttempts === 1)
        await route.fulfill({
          status: 500,
          json: {
            error: { code: "INTERNAL_ERROR", message: "Temporary failure" },
          },
        });
      else await route.continue();
    },
  );
  await page
    .getByRole("button", { name: "Preview upgrade", exact: true })
    .click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByLabel("Folder", { exact: true })).toBeVisible();
  expect(previewAttempts).toBe(2);
  expect((await detail()).path.version).toBe("1.0.0");
  await page
    .getByRole("button", { name: "Cancel upgrade", exact: true })
    .click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.unroute("**/api/plugin-configurations/*/upgrade-preview");
  await page.goto(service.url + "/app/plugins");
  await page.getByRole("button", { name: "Upgrade", exact: true }).click();
  await page
    .getByRole("combobox", { name: /^Target version/ })
    .selectOption("2.0.0");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Upgrade", exact: true })
    .click();
  await expect(page.getByLabel("Folder", { exact: true })).toBeVisible();
  expect((await detail()).path.version).toBe("1.0.0");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Folder", { exact: true })).toHaveCount(0);
  expect((await detail()).path.version).toBe("1.0.0");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Upgrade", exact: true })
    .click();
  await page.getByLabel("Folder", { exact: true }).fill("new");
  await page.getByRole("button", { name: "Save upgrade", exact: true }).click();
  await expect(page.getByLabel("Folder", { exact: true })).toHaveCount(0);
  expect((await detail()).path).toMatchObject({
    key: old.path.key,
    version: "2.0.0",
    config: { folder: "new" },
  });
  // Same schema: one click commits without opening a configuration editor.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Upgrade", exact: true })
    .click();
  await expect(
    page.getByText("All configurations are up to date."),
  ).toBeVisible();
  await expect(page.getByLabel("Folder", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Upgrade", exact: true }),
  ).toHaveCount(0);
  expect((await detail()).path).toMatchObject({
    version: "3.0.0",
    config: { folder: "new" },
  });
  expect(
    (
      await page.request.delete(
        service.url + "/api/plugins/example.upgrade-path/versions/1.0.0",
        { headers },
      )
    ).status(),
  ).toBe(200);
  await service.restart();
  expect((await detail()).path).toMatchObject({
    key: old.path.key,
    version: "3.0.0",
    ready: true,
  });
});

test("upgrade exposes removed parameters even when their names match object methods", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "x-csrf-token": session.csrfToken };
  for (const version of ["1", "2"]) {
    const manifest = {
      id: "example.param-upgrade",
      version,
      kind: "processor",
      apiVersion: 1,
      entry: "index.js",
    };
    const definition = {
      ...manifest,
      defaultLocale: "en-US",
      nameKey: "name",
      messages: { "en-US": { name: "Parameter upgrade" } },
      stages: {
        upload: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          paramsSchema: {
            type: "object",
            properties: Object.fromEntries(
              version === "1" ? [["toString", { type: "string" }]] : [],
            ),
          },
        },
      },
    };
    const code = `const d=${JSON.stringify(definition)};d.stages.upload.createInstance=async()=>({check:async()=>({status:'applicable'}),process:async()=>({status:'pass'})});export default d;`;
    const inspected = await page.request.post(
      service.url + "/api/plugins/inspect",
      {
        headers,
        multipart: {
          file: {
            name: "plugin.zip",
            mimeType: "application/zip",
            buffer: zip({
              "plugin.json": JSON.stringify(manifest),
              "index.js": code,
            }),
          },
        },
      },
    );
    expect(inspected.status()).toBe(200);
    const { ticket } = await inspected.json();
    expect(
      (
        await page.request.post(service.url + "/api/plugins/install", {
          headers,
          data: { ticket, confirmTrusted: true },
        })
      ).status(),
    ).toBe(201);
  }
  const created = await page.request.post(service.url + "/api/pipelines", {
    headers,
    data: {
      name: "Parameter upgrade",
      kind: "upload",
      steps: [
        {
          pluginId: "example.param-upgrade",
          version: "1",
          config: {},
          enabledParams: ["toString"],
          onNotApplicable: "abort",
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto(service.url + "/app/config/pipelines");
  await page
    .getByRole("heading", { name: "Parameter upgrade", exact: true })
    .locator("../..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: /^Target version/ })
    .selectOption("2");
  await page
    .getByRole("button", { name: "Preview upgrade", exact: true })
    .click();
  const removedParameter = page.getByRole("checkbox", {
    name: "toString",
    exact: true,
  });
  await expect(removedParameter).toBeChecked();
  await removedParameter.click();
  await expect(removedParameter).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const pipelines = await (
    await page.request.get(service.url + "/api/pipelines")
  ).json();
  expect(
    pipelines.find((p: any) => p.name === "Parameter upgrade").steps[0],
  ).toMatchObject({ version: "2", enabledParams: [] });
});
