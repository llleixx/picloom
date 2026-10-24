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
    await m.getByRole("link", { name: "Upload", exact: true }).click();
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
    await m.getByRole("link", { name: "App", exact: true }).click();
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
    await m.reload();
    await expect(m.getByTestId("file-card")).toHaveCount(1);
    await page.getByRole("link", { name: "Images", exact: true }).click();
    await page.reload();
    const scope = page.getByRole("combobox", {
      name: "Image scope",
      exact: true,
    });
    await expect(scope).toHaveValue("mine");
    await expect(page.getByTestId("file-card")).toHaveCount(0);
    await scope.selectOption("all");
    await expect(page.getByTestId("file-card")).toHaveCount(2);
    await expect(
      page.getByTestId("file-card").getByText("alice", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("file-card").getByText("Guest", { exact: true }),
    ).toBeVisible();
    await page.goto(service.url + "/app/images");
    await expect(scope).toHaveValue("all");
    await scope.selectOption("mine");
    await page.goto(service.url + "/app/images?owner=guest");
    await expect(scope).toHaveValue("all");
    await openImageFilters(page);
    const filters = page.getByRole("dialog", {
      name: "Filters & sort",
      exact: true,
    });
    await expect(
      filters.getByRole("button", { name: "Add tags", exact: true }),
    ).toHaveCount(0);
    const owner = page.getByRole("combobox", { name: "Owner", exact: true });
    await owner.click();
    await page.getByRole("option", { name: "All users", exact: true }).click();
    await expect(scope).toHaveValue("all");
    await expect(page.getByTestId("file-card")).toHaveCount(2);
    await owner.click();
    await owner.fill("ali");
    await page.getByRole("option", { name: "alice", exact: true }).click();
    await expect(
      filters.getByRole("button", { name: "Add tags", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await owner.click();
    await owner.fill("");
    await page.getByRole("combobox", { name: "Owner", exact: true }).click();
    await page.getByRole("option", { name: "Guest", exact: true }).click();
    await closeImageFilters(page);
    await expect(page.getByTestId("file-card")).toHaveCount(1);
    await page.getByRole("button", { name: /^Open / }).click();
    await expect(
      page.getByRole("dialog").getByText("Guest", { exact: true }),
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
