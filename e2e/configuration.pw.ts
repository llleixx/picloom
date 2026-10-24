import { test, expect, login, expandDetails } from "./fixtures";
import { mkdir } from "node:fs/promises";
test.use({ scenario: "configuration" });
test("manage instances, groups, profiles and chains, then upload multiple copies and execute actions", async ({
  page,
  service,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Storage Sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Plugin", { exact: true })
    .selectOption("builtin.local@1.0.0");
  await page.getByLabel("Source name").fill("Managed replica");
  await page
    .getByLabel("Root directory", { exact: false })
    .fill(service.root + "/managed-replica");
  await expect(page.getByLabel("Shared weight")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Managed replica", exact: true }),
  ).toBeVisible();
  const instances = await (
    await page.request.get(service.url + "/api/storage-sources")
  ).json();
  await mkdir("outputs", { recursive: true });
  await page.screenshot({ path: "outputs/configuration-instances.png" });
  const replica = instances.find((i: any) => i.name === "Managed replica"),
    primary = instances.find((i: any) => i.name === "Default local storage");
  await page.getByRole("link", { name: "Storage Groups", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Group name").fill("Managed group");
  for (const id of [primary.id, replica.id]) {
    await page.getByLabel("Storage member").selectOption(id);
    await page.getByRole("button", { name: "Add member", exact: true }).click();
  }
  await page
    .getByLabel("Storage selection strategy", { exact: true })
    .selectOption("weighted_random");
  await page.getByLabel("Member 1 weight", { exact: true }).fill("1");
  await page.getByLabel("Member 2 weight", { exact: true }).fill("3");
  await page.getByRole("spinbutton", { name: /^Number of copies/ }).fill("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  ).find((g: any) => g.name === "Managed group");
  expect(group.members.map((m: any) => m.weight)).toEqual([1, 3]);
  expect(group.replicaCount).toBe(2);
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Profile name").fill("Managed upload");
  await page.getByLabel("Public prefix").fill("/managed/");
  await page.getByLabel("Path plugin").selectOption("builtin.date-path@1.0.0");
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByRole("button", { name: "New", exact: true }).first().click();
  await page.getByLabel("Pipeline name").fill("Optimize images");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByLabel("Processor plugin").selectOption("builtin.sharp@1.0.0");
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("button", { name: "New", exact: true }).last().click();
  await page.getByLabel("Pipeline name").fill("Notify uploads");
  await page
    .getByRole("button", { name: "Add step", exact: true })
    .last()
    .click();
  await page.getByLabel("Processor plugin").selectOption("test.webhook@1.0.0");
  await page
    .getByLabel("Target URL", { exact: false })
    .fill(service.url + "/test-hook");
  await page.getByLabel("Bearer Token", { exact: true }).fill("test-token");
  await page
    .getByRole("dialog")
    .last()
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profile = (
    await (await page.request.get(service.url + "/api/upload-profiles")).json()
  ).find((p: any) => p.name === "Managed upload");
  expect(profile.available).toBe(true);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  const sharedRow = page
    .getByRole("heading", { name: "Optimize images", exact: true })
    .locator("..")
    .locator("..");
  await expect(sharedRow).toContainText("Managed upload");
  await expect(
    sharedRow.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  await sharedRow
    .getByRole("button", { name: "Duplicate", exact: true })
    .click();
  await page.getByLabel("Pipeline name").fill("Independent copy");
  await page.getByLabel("Quality", { exact: true }).fill("70");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const copyRow = page
    .getByRole("heading", { name: "Independent copy", exact: true })
    .locator("..")
    .locator("..");
  await copyRow.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(copyRow).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Pipelines", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("heading", { name: "Access pipeline", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page.getByLabel("Unsupported behavior").selectOption("skip");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Images", exact: true }).click();
  await page
    .getByRole("button", { name: "Upload images", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Upload profile", { exact: true })
    .selectOption(profile.id);
  await page.getByTestId("upload-input").setInputFiles({
    name: "test.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="15"/></svg>',
    ),
  });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /^Open / }).click();
  const url = await page
    .getByRole("textbox", { name: "Access link", exact: true })
    .inputValue();
  expect(url).toContain("/managed/");
  await expandDetails(page, "file-processing");
  await expect(
    page.getByText("Replication · Completed", { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByText("Post-Save Pipeline · Completed", { exact: true }),
  ).toBeVisible();
  await mkdir("outputs", { recursive: true });
  await page.getByRole("dialog").evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await page.getByTestId("file-processing").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "outputs/configuration-operations.png" });
  await page.getByRole("button", { name: "Delete image", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page
      .getByTestId("detail-body")
      .getByRole("status")
      .filter({ hasText: "Removed" }),
  ).toBeVisible();
  expect((await page.request.get(url)).status()).toBe(404);
  expect(errors).toEqual([]);
});

test("schema form supports nested arrays, sensitive arrays and conditions, and keeps drafts on conflicts", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("test.form@1");
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  )[0];
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByLabel("Profile name").fill("Schema profile");
  await expect(page.getByLabel("Details", { exact: true })).toHaveCount(0);
  await page.getByLabel("Show details", { exact: true }).selectOption("true");
  await page.getByLabel("Details", { exact: true }).fill("value");
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  await page.getByLabel("Nested name").fill("nested");
  await page
    .getByRole("button", { name: "Add item", exact: true })
    .first()
    .click();
  await page.getByLabel("Item name").fill("first");
  await page
    .getByRole("button", { name: "Add item", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: "Set to null", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Remove item", exact: true }),
  ).toHaveCount(2);
  await page
    .getByLabel("Secret items", { exact: true })
    .fill('[{"token":"secret-array-token"}]');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const option = (
    await (await page.request.get(service.url + "/api/upload-profiles")).json()
  ).find((p: any) => p.name === "Schema profile");
  const profile = await (
    await page.request.get(service.url + "/api/upload-profiles/" + option.id)
  ).json();
  const instance = profile.path;
  expect(instance.secretPresence["/secretItems"]).toBe(true);
  expect(JSON.stringify(instance)).not.toContain("secret-array-token");
  expect(instance.config.nested.label).toBe("nested");
  expect(instance.config.items[0].name).toBe("first");
  expect(instance.config.nulls).toEqual([null]);
  const row = page
    .getByRole("heading", { name: "Schema profile", exact: true })
    .locator("..")
    .locator("..");
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Secret items", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByText("Saved value kept unless edited.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Profile name").fill("my draft");
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toHaveCount(0);
  const external = await page.request.put(
    service.url + "/api/upload-profiles/" + profile.id,
    {
      headers: { "X-CSRF-Token": session.csrfToken },
      data: {
        ...profile,
        name: "external change",
        expectedVersion: profile.configVersion,
        path: {
          ...instance,
          secretEdits: { "/secretItems": { action: "preserve" } },
        },
      },
    },
  );
  expect(external.status()).toBe(200);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Your draft is preserved",
  );
  await expect(page.getByLabel("Profile name")).toHaveValue("my draft");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.getByLabel("Profile name")).toHaveValue("external change");
  await expect(
    page.getByRole("button", { name: "Reload", exact: true }),
  ).toHaveCount(0);
});

test("English configuration forms remain readable on desktop and mobile", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page
    .getByRole("link", { name: "Storage Sources", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Plugin", { exact: true })
    .selectOption("builtin.s3@1.0.0");
  await expect(
    page.getByLabel("Path-style addressing", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  await expect(page.getByLabel("Session Token", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(/[\u4e00-\u9fff]/);
  await page.screenshot({ path: "outputs/english-source-form.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "outputs/english-source-mobile.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("builtin.date-path@1.0.0");
  await expect(
    page.getByLabel("Upload Pipeline", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Post-Save Pipeline", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(/[\u4e00-\u9fff]/);
  await page.screenshot({ path: "outputs/english-profile-form.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page
    .getByRole("heading", { name: "Access pipeline", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByLabel("Unsupported behavior")).toBeVisible();
  await expect(page.getByRole("dialog")).not.toContainText(/[\u4e00-\u9fff]/);
  await page.getByRole("dialog").evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
  });
  await page.screenshot({ path: "outputs/english-access-pipeline.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Unsupported behavior")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "outputs/pipeline-mobile.png" });
});

test("processor forms use stage settings and persist request parameter permissions", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Pipeline name").fill("Fixed image optimization");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  const selector = page.getByLabel("Processor plugin", { exact: true });
  await expect(
    selector.locator('option[value="test.webhook@1.0.0"]'),
  ).toHaveCount(0);
  await selector.selectOption("builtin.sharp@1.0.0");
  await page.getByLabel("Width", { exact: true }).fill("1280");
  await page.getByLabel("Quality", { exact: true }).fill("80");
  await page
    .getByLabel("Output format", { exact: true })
    .selectOption('"webp"');
  await expect(
    page.getByRole("group", { name: "Request parameters" }),
  ).toHaveCount(1);
  await page.getByLabel("Enable q", { exact: true }).uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("heading", { name: "Access pipeline", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByLabel("Width", { exact: true })).toHaveCount(0);
  await page.getByLabel("Enable q", { exact: true }).uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  const values = await (
    await page.request.get(service.url + "/api/pipelines")
  ).json();
  expect(
    values.find((p: any) => p.kind === "upload").steps[0].config,
  ).toMatchObject({ w: 1280, q: 80, format: "webp" });
  expect(
    values.find((p: any) => p.kind === "upload").steps[0].enabledParams,
  ).not.toContain("q");
  const step = values.find((p: any) => p.kind === "access").steps[0];
  expect(step.config).toEqual({});
  expect(step.enabledParams).not.toContain("q");
  expect(step.enabledParams).toContain("w");
  await page
    .getByRole("heading", { name: "Access pipeline", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByLabel("Enable q", { exact: true })).not.toBeChecked();
});

test("pipeline errors identify the step and submissions keep the drawer open", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Pipeline name").fill("Validation feedback");
  await page.getByLabel("Pipeline type").selectOption("post_save");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByLabel("Processor plugin").selectOption("test.webhook@1.0.0");
  await page.getByLabel("Target URL", { exact: true }).fill("invalid-url");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByLabel("Processor plugin").selectOption("test.webhook@1.0.0");
  await page
    .getByLabel("Target URL", { exact: true })
    .fill("https://example.com/notify");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Target URL", { exact: true })).toHaveValue(
    "invalid-url",
  );
  await expect(page.getByLabel("Target URL", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page
    .getByLabel("Target URL", { exact: true })
    .fill("https://example.com/notify");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/pipelines", async (route) => {
    if (route.request().method() === "POST") await hold;
    await route.continue();
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(
      page.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    const save = await page
      .getByRole("button", { name: "Saving…", exact: true })
      .boundingBox();
    expect(save!.y + save!.height).toBeLessThanOrEqual(844);
  } finally {
    release();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("storage source uses the shared editor and preserves hidden credentials on edit", async ({
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
    .selectOption("builtin.s3@1.0.0");
  await page.getByLabel("Source name", { exact: true }).fill("Credential form");
  await page
    .getByLabel("Endpoint", { exact: true })
    .fill("https://s3.example.com");
  await page.getByLabel("Region", { exact: true }).fill("us-east-1");
  await page.getByLabel("Bucket", { exact: true }).fill("test-bucket");
  for (const label of ["Access Key ID", "Secret Access Key"]) {
    await page.getByLabel(label, { exact: true }).fill("test-credential");
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("heading", { name: "Credential form", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByLabel("Plugin", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Endpoint", { exact: true })).toBeDisabled();
  const secret = page.getByLabel("Secret Access Key", { exact: true });
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Show Secret Access Key", exact: true })
    .click();
  await expect(secret).toHaveValue("test-credential");
  await expect(secret).toHaveAttribute("type", "text");
  await page
    .getByRole("button", { name: "Hide Secret Access Key", exact: true })
    .click();
  await expect(secret).toHaveAttribute("type", "password");
  await page.getByLabel("Source name", { exact: true }).fill("Renamed source");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const sources = await (
    await page.request.get(service.url + "/api/storage-sources")
  ).json();
  const saved = sources.find((s: any) => s.name === "Renamed source");
  expect(saved.ready).toBe(true);
  expect(saved.secretPresence["/secretAccessKey"]).toBe(true);
  expect(saved.config.secretAccessKey).toBeUndefined();
  await page
    .getByRole("heading", { name: "Renamed source", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  await page
    .getByLabel("Session Token", { exact: true })
    .fill("optional-token");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("heading", { name: "Renamed source", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Clear Session Token", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const cleared = await (
    await page.request.get(service.url + "/api/storage-sources/" + saved.id)
  ).json();
  expect(cleared.secretPresence["/sessionToken"]).not.toBe(true);
});

test("new plugin drafts do not restore removed defaults on rerenders or save", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // Retry a failed explicit selection; details loading must never initialize a draft.
  await page.route(
    "**/api/plugins/test.form/versions/1",
    (route) => route.abort(),
    { times: 1 },
  );
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("test.form@1");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  )[0];
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByLabel("Profile name").fill("Removed defaults");
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  const nested = page.getByLabel("Nested name", { exact: true });
  await expect(nested).toHaveValue("default");
  await nested
    .locator("..")
    .getByRole("button", { name: "Remove field", exact: true })
    .click();
  await expect(nested).toHaveValue("");
  // Force a UI rerender without replacing the draft.
  await page.getByLabel("Show details", { exact: true }).selectOption("true");
  await page.getByLabel("Show details", { exact: true }).selectOption("false");
  await expect(nested).toHaveValue("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const profile = profiles.find((p: any) => p.name === "Removed defaults");
  const detail = await (
    await page.request.get(service.url + "/api/upload-profiles/" + profile.id)
  ).json();
  expect(detail.path.config.nested).toEqual({});
});

test("explicit empty objects and empty secrets preserve missing-value distinctions", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("test.form@1");
  await expect(page.getByLabel("toString", { exact: true })).toHaveValue("");
  const empty = page.getByRole("button", {
    name: "Set empty object",
    exact: true,
  });
  await expect(empty).toBeVisible();
  await empty.click();
  await expect(empty).toHaveCount(0);
  await page.getByLabel("Empty secret", { exact: true }).fill("temporary");
  await page.getByLabel("Empty secret", { exact: true }).fill("");
  await expect(
    page.getByRole("button", { name: "Clear Empty secret", exact: true }),
  ).toBeVisible();
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  )[0];
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByLabel("Profile name").fill("Explicit empty values");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const profile = profiles.find((p: any) => p.name === "Explicit empty values");
  const detail = await (
    await page.request.get(service.url + "/api/upload-profiles/" + profile.id)
  ).json();
  expect(detail.path.config.empty).toEqual({});
  expect(Object.hasOwn(detail.path.config, "toString")).toBe(false);
  expect(detail.path.secretPresence["/emptySecret"]).toBe(true);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const revealed = await (
    await page.request.post(
      service.url +
        "/api/plugin-configurations/" +
        detail.path.key +
        "/reveal-secret",
      {
        headers: { "X-CSRF-Token": session.csrfToken },
        data: { path: "/emptySecret" },
      },
    )
  ).json();
  expect(revealed.value).toBe("");
  await page
    .getByRole("heading", { name: "Explicit empty values", exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Clear Empty secret", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const cleared = await (
    await page.request.get(service.url + "/api/upload-profiles/" + profile.id)
  ).json();
  expect(cleared.path.secretPresence["/emptySecret"]).not.toBe(true);
});

test("nested array drafts follow their row through reorder and removal", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page
    .getByRole("link", { name: "Upload Profiles", exact: true })
    .click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByLabel("Path plugin", { exact: true })
    .selectOption("test.form@1");
  const items = page.getByText("Items", { exact: true }).locator("../..");
  const rows = items.locator(":scope > div.border-l");
  for (const name of ["A", "B", "C"]) {
    await items
      .getByRole("button", { name: "Add item", exact: true })
      .last()
      .click();
    await rows.last().getByLabel("Item name", { exact: true }).fill(name);
  }
  await rows
    .first()
    .getByRole("button", { name: "Add item", exact: true })
    .click();
  await page.getByLabel("New item", { exact: true }).fill("draft-for-A");
  await rows
    .first()
    .getByRole("button", { name: "Move item down", exact: true })
    .click();
  await expect(
    rows.nth(1).getByLabel("Item name", { exact: true }),
  ).toHaveValue("A");
  await expect(rows.nth(1).getByLabel("New item", { exact: true })).toHaveValue(
    "draft-for-A",
  );
  await rows
    .nth(1)
    .getByRole("button", { name: "Add item", exact: true })
    .click();
  await rows
    .nth(2)
    .getByRole("button", { name: "Add item", exact: true })
    .click();
  await page.getByLabel("New item", { exact: true }).fill("draft-for-C");
  await rows
    .first()
    .getByRole("button", { name: "Remove item", exact: true })
    .click();
  await expect(
    rows.nth(1).getByLabel("Item name", { exact: true }),
  ).toHaveValue("C");
  await expect(rows.nth(1).getByLabel("New item", { exact: true })).toHaveValue(
    "draft-for-C",
  );
  await rows
    .nth(1)
    .getByRole("button", { name: "Add item", exact: true })
    .click();
  const group = (
    await (await page.request.get(service.url + "/api/storage-groups")).json()
  )[0];
  await page
    .getByLabel("Storage group", { exact: true })
    .selectOption(group.id);
  await page.getByLabel("Profile name").fill("Array row drafts");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const profile = profiles.find((p: any) => p.name === "Array row drafts");
  const detail = await (
    await page.request.get(service.url + "/api/upload-profiles/" + profile.id)
  ).json();
  expect(detail.path.config.items).toEqual([
    { name: "A", tags: ["draft-for-A"] },
    { name: "C", tags: ["draft-for-C"] },
  ]);
});
