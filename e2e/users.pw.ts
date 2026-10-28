import {
  test,
  expect,
  login,
  openImageFilters,
  closeImageFilters,
} from "./fixtures";
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

test("administrator creates a member; member and guest upload with isolated workspaces", async ({
  page,
  service,
  browser,
}) => {
  await login(page, service.url);
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("alice");
  await page
    .getByLabel("Password", { exact: true })
    .fill("member-password-123");
  await page
    .getByRole("checkbox", { name: profiles[0].name, exact: true })
    .check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "alice", exact: true }),
  ).toBeVisible();
  await mkdir("outputs", { recursive: true });
  await page.screenshot({ path: "outputs/users.png" });
  const member = await browser.newContext(),
    guest = await browser.newContext();
  try {
    const m = await member.newPage(),
      g = await guest.newPage();
    await g.goto(service.url + "/");
    await expect(
      g.getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      g.getByRole("button", { name: "Choose files", exact: true }),
    ).toBeDisabled();
    await m.goto(service.url + "/app/images");
    await m.getByLabel("Username", { exact: true }).fill("alice");
    await m.getByLabel("Password", { exact: true }).fill("member-password-123");
    await m.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      m.getByRole("heading", { name: "Images", exact: true }),
    ).toBeVisible();
    await expect(
      m.getByRole("link", { name: "Users", exact: true }),
    ).toHaveCount(0);
    await expect(
      m.getByRole("link", { name: "Storage Sources", exact: true }),
    ).toHaveCount(0);
    await m.goto(service.url + "/app/settings/");
    await expect(m).toHaveURL(service.url + "/app/images");
    await m
      .getByRole("button", { name: "Upload images", exact: true })
      .first()
      .click();
    const png = await sharp({
      create: { width: 24, height: 24, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    await m.getByTestId("upload-input").setInputFiles({
      name: "member.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(m.getByText("Uploaded", { exact: true })).toBeVisible();
    await m.getByRole("button", { name: "Close", exact: true }).click();
    await expect(m.getByTestId("file-card")).toHaveCount(1);
    await expect(
      m.getByRole("combobox", { name: "Image scope", exact: true }),
    ).toHaveCount(0);
    await m.getByRole("button", { name: /^Open / }).click();
    await expect(
      m.getByRole("heading", { name: "Replicas", exact: true }),
    ).toHaveCount(0);
    await m.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("link", { name: "Upload Profiles", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Allow guest uploads", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await g.reload();
    await expect(
      g.getByRole("button", { name: "Choose files", exact: true }),
    ).toBeEnabled();
    // The public UI must send the per-upload key even without a login cookie.
    const keys: string[] = [];
    g.on("request", (req) => {
      if (req.method() === "PUT" && req.url().includes("/parts/"))
        keys.push(req.headers()["x-upload-key"] ?? "");
    });
    await g.getByTestId("upload-input").setInputFiles({
      name: "guest.png",
      mimeType: "image/png",
      buffer: Buffer.concat([png, Buffer.alloc(9 * 1024 ** 2)]),
    });
    await expect(g.getByText("Uploaded", { exact: true })).toBeVisible();
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.every((key) => key.length > 30)).toBe(true);
    const guestFiles = await (
      await page.request.get(service.url + "/api/files?owner=guest")
    ).json();
    const guestLabel = guestFiles[0].guestIp;
    expect(guestLabel).toBeTruthy();
    await m.reload();
    await expect(m.getByTestId("file-card")).toHaveCount(1);
    await page.getByRole("link", { name: "Images", exact: true }).click();
    await page.reload();
    const scope = page.getByRole("combobox", {
      name: "Image scope",
      exact: true,
    });
    await expect(scope).toHaveValue("My Images");
    await expect(page.getByTestId("file-card")).toHaveCount(0);
    await scope.click();
    await page.getByRole("option", { name: "All Images", exact: true }).click();
    await expect(page.getByTestId("file-card")).toHaveCount(2);
    await expect(
      page.getByTestId("file-card").getByText("alice", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-card").getByText(guestLabel, { exact: true }),
    ).toBeVisible();
    await page.goto(service.url + "/app/images");
    await expect(scope).toHaveValue("All Images");
    await scope.click();
    await page.getByRole("option", { name: "My Images", exact: true }).click();
    await page.goto(service.url + "/app/images?owner=guest");
    await expect(scope).toHaveValue("Guest");
    await openImageFilters(page);
    const filters = page.getByRole("dialog", {
      name: "Filters & sort",
      exact: true,
    });
    await expect(
      filters.getByRole("button", { name: "Add tags", exact: true }),
    ).toHaveCount(0);
    await closeImageFilters(page);
    const owner = scope;
    await owner.click();
    await page.getByRole("option", { name: "All Images", exact: true }).click();
    await expect(scope).toHaveValue("All Images");
    await expect(page.getByTestId("file-card")).toHaveCount(2);
    await owner.click();
    await owner.fill("ali");
    await page.getByRole("option", { name: "alice", exact: true }).click();
    await expect(scope).toHaveValue("alice");
    await openImageFilters(page);
    await expect(
      filters.getByRole("button", { name: "Add tags", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await closeImageFilters(page);
    await owner.click();
    await owner.fill("");
    await page.getByRole("option", { name: "Guest", exact: true }).click();
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await page.getByRole("button", { name: /^Open / }).click();
    await expect(
      page.getByRole("dialog").getByText(guestLabel, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await page
      .getByRole("article")
      .filter({ hasText: "alice" })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Account status", exact: true })
      .selectOption("disabled");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await m.reload();
    await expect(
      m.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  } finally {
    await member.close();
    await guest.close();
  }
});

test("owner appoints admins and admin editor only manages members", async ({
  page,
  service,
  browser,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await expect(
    page
      .locator("article")
      .filter({
        has: page.getByRole("heading", { name: "admin", exact: true }),
      })
      .getByRole("button", { name: "Edit", exact: true }),
  ).toHaveCount(0);
  for (const [username, role] of [
    ["manager", "admin"],
    ["ordinary", "member"],
  ]) {
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill(username!);
    await page
      .getByLabel("Password", { exact: true })
      .fill("member-password-123");
    await page
      .getByRole("combobox", { name: "Role", exact: true })
      .selectOption(role!);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const context = await browser.newContext();
  try {
    const p = await context.newPage();
    await p.goto(service.url + "/login");
    await p.getByLabel("Username", { exact: true }).fill("manager");
    await p.getByLabel("Password", { exact: true }).fill("member-password-123");
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await p.getByRole("link", { name: "Users", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "Edit", exact: true }),
    ).toHaveCount(1);
    await p.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      p.getByRole("combobox", { name: "Role", exact: true }),
    ).toBeDisabled();
    await p
      .getByRole("combobox", { name: "Account status", exact: true })
      .selectOption("disabled");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await expect(p.getByRole("dialog")).toHaveCount(0);
    await expect(
      p.locator("article").filter({
        has: p.getByRole("heading", { name: "ordinary", exact: true }),
      }),
    ).toContainText("Disabled");
  } finally {
    await context.close();
  }
});

test("deleting a user keeps images and displays historical IDs in the list and detail", async ({
  page,
  service,
  browser,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "x-csrf-token": session.csrfToken };
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const created = await page.request.post(service.url + "/api/users", {
    headers,
    data: {
      username: "departing",
      password: "test-password-123",
      role: "member",
      profileIds: [profiles[0].id],
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const member = await browser.newContext();
  try {
    const p = await member.newPage();
    await p.goto(service.url + "/login");
    await p.getByLabel("Username", { exact: true }).fill("departing");
    await p.getByLabel("Password", { exact: true }).fill("test-password-123");
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      p.getByRole("heading", { name: "Images", exact: true }),
    ).toBeVisible();
    const memberSession = await (
      await p.request.get(service.url + "/api/auth/session")
    ).json();
    const png = await sharp({
      create: { width: 12, height: 12, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const upload = await p.request.post(service.url + "/api/files", {
      headers: { "x-csrf-token": memberSession.csrfToken },
      multipart: {
        profileId: profiles[0].id,
        file: { name: "retained.png", mimeType: "image/png", buffer: png },
      },
    });
    expect(upload.ok()).toBe(true);
    const image = await upload.json();
    await page.goto(service.url + "/app/users");
    const row = page.locator("article").filter({ hasText: "departing" });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: /Delete/ }),
    ).toHaveCount(0);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await row
      .getByRole("button", { name: "More actions for departing", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Delete user departing?",
      exact: true,
    });
    await expect(confirmation).toContainText(
      "Images and public links will remain",
    );
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await row
      .getByRole("button", { name: "More actions for departing", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deleteUrl = service.url + "/api/users/" + id;
    await page.route(deleteUrl, (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "Forbidden" },
        }),
      }),
    );
    await confirmation
      .getByRole("button", { name: "Confirm delete", exact: true })
      .click();
    await expect(confirmation.getByRole("alert")).toBeVisible();
    await expect(confirmation).toBeVisible();
    await page.unroute(deleteUrl);
    await confirmation
      .getByRole("button", { name: "Confirm delete", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "departing", exact: true }),
    ).toHaveCount(0);
    expect(
      (await p.request.get(service.url + "/api/auth/session")).status(),
    ).toBe(401);
    await page.goto(service.url + "/app/images");
    const scope = page.getByRole("combobox", {
      name: "Image scope",
      exact: true,
    });
    await scope.click();
    await scope.fill(id.slice(0, 12));
    await page.getByRole("option", { name: id, exact: true }).click();
    await expect(scope).toHaveValue(id);
    await expect(page).toHaveURL(new RegExp("owner=" + id));
    await expect(
      page.getByTestId("file-card").getByText(id, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Open / }).click();
    const detail = page.getByRole("dialog");
    await expect(detail.getByText(id, { exact: true })).toBeVisible();
    await expect(detail.getByTestId("file-information")).toContainText(
      "Upload · " + id,
    );
    expect((await page.request.get(image.url)).status()).toBe(200);
  } finally {
    await member.close();
  }
});
