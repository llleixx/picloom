import {
  test,
  expect,
  login,
  openImageFilters,
  closeImageFilters,
} from "./fixtures";

const image = {
  name: "organized.svg",
  mimeType: "image/svg+xml",
  buffer: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="green"/></svg>',
  ),
};

test("empty category management, collection upload, detail and batch organization", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Collections", exact: true }).click();
  await expect(page).toHaveURL(service.url + "/app/collections");
  await expect(
    page.getByRole("heading", { name: "Collections", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New collection", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Trips");
  await page.getByLabel("Description", { exact: true }).fill("Travel photos");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article")).toContainText("Available images: 0");
  await page.getByRole("button", { name: "Trips", exact: true }).last().click();
  await expect(
    page.getByRole("heading", { name: "Trips", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Upload to this collection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove Trips", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  const tagPicker = page.getByRole("group", { name: "Tags", exact: true });
  await tagPicker.getByLabel("Search tags", { exact: true }).fill("Summer");
  await tagPicker.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove Summer", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("upload-input").setInputFiles(image);
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await expect(page.getByTestId("file-card")).toContainText("Summer");
  let detailReads = 0;
  await page.route(/\/api\/files\/[^/]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        backgroundPending: ++detailReads === 1,
      },
    });
  });
  await page.getByRole("button", { name: /^Open / }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("Trips", { exact: true })).toBeVisible();
  await expect(detail.locator("img").first()).toHaveJSProperty(
    "complete",
    true,
  );
  await detail
    .getByRole("button", { name: "Edit organization", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Remove Summer", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Remove Trips", exact: true })
    .click();
  // Finishing background work refreshes the same file while both drafts are dirty.
  await expect.poll(() => detailReads).toBeGreaterThan(1);
  await expect(detail.getByText(/Background processing/)).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Remove Summer", exact: true }),
  ).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Remove Trips", exact: true }),
  ).toHaveCount(0);
  await detail
    .getByRole("button", { name: "Add collections", exact: true })
    .click();
  await detail
    .getByRole("group", { name: "Collections", exact: true })
    .getByRole("button", { name: "Trips", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    detail.getByText("Changes saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("file-card")).not.toContainText("Summer");
  await page.getByTestId("file-card").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Edit organization", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("group", { name: "Tags", exact: true })
    .getByRole("button", { name: "Summer", exact: true })
    .click();
  await page.getByRole("button", { name: "Add selected", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Changes saved.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("file-card")).toContainText("Summer");
  await openImageFilters(page);
  await page.getByRole("checkbox", { name: "Untagged", exact: true }).check();
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Untagged", exact: true }).uncheck();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page
    .getByRole("checkbox", { name: "Not in a collection", exact: true })
    .check();
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "Not in a collection", exact: true })
    .uncheck();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await closeImageFilters(page);
  await page.getByRole("link", { name: "Collections", exact: true }).click();
  await expect(page.getByRole("article")).toContainText("Available images: 1");
  await expect(page.getByRole("article").locator("img")).toHaveJSProperty(
    "complete",
    true,
  );
  await page.getByRole("link", { name: "Tags", exact: true }).click();
  await expect(page).toHaveURL(service.url + "/app/tags");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Tags", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New tag", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Empty tag");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Empty tag", exact: true }),
  ).toBeVisible();
  const empty = page.getByRole("article").filter({
    has: page.getByRole("button", { name: "Empty tag", exact: true }),
  });
  await empty
    .getByRole("button", { name: "More actions for Empty tag", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename tag", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Renamed tag");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Renamed tag", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "More actions for Renamed tag",
      exact: true,
    }),
  ).toBeFocused();
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("button", { name: "Renamed tag", exact: true }),
    })
    .getByRole("button", { name: "More actions for Renamed tag", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(
    page.getByText(
      "Deleting this definition removes its relationships. Images are kept.",
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Renamed tag", exact: true }),
  ).toHaveCount(0);
});

test("other users’ collections never offer uploading and homepage snapshots each queued selection", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const member = await (
    await page.request.post(service.url + "/api/users", {
      headers,
      data: {
        username: "member",
        password: "member-password-123",
        role: "member",
        profileIds: [],
      },
    })
  ).json();
  const foreign = await (
    await page.request.post(service.url + "/api/collections", {
      headers,
      data: { name: "Member collection", ownerId: member.id },
    })
  ).json();
  await page.goto(service.url + "/app/collections");
  await expect(
    page.getByRole("heading", { name: "Collections", exact: true }),
  ).toBeVisible();
  const owner = page.getByRole("combobox", { name: "Owner", exact: true });
  await owner.click();
  await expect(
    page.getByRole("option", { name: "Guest", exact: true }),
  ).toHaveCount(0);
  await owner.fill("mem");
  await page.getByRole("option", { name: "member", exact: true }).click();
  await expect(owner).toHaveValue("member");
  await expect(page.getByRole("article")).toContainText("Member collection");
  await page.goto(service.url + "/app/images?owner=guest");
  await openImageFilters(page);
  await expect(
    page.getByRole("group", { name: "Tags", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Collections", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Tag matching", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Untagged", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Not in a collection", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Order", { exact: true })).toBeVisible();
  await closeImageFilters(page);
  await page.goto(service.url + "/app/images?collection=" + foreign.id);
  await expect(
    page.getByRole("heading", { name: "Member collection", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Upload/ })).toHaveCount(0);
  await page.route("**/api/client-settings", async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      json: { ...(await res.json()), uploadConcurrency: 1 },
    });
  });
  await page.goto(service.url + "/");
  await page.getByRole("button", { name: "Add tags", exact: true }).click();
  const tags = page.getByRole("group", { name: "Tags", exact: true });
  await tags.getByRole("textbox").fill("First batch");
  await tags.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove First batch", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const requests: string[] = [];
  let releaseFirst!: () => void;
  const firstTransfer = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route("**/api/files", async (route) => {
    if (route.request().method() === "POST")
      requests.push(route.request().postData() ?? "");
    if (requests.length === 1) await firstTransfer;
    await route.continue();
  });
  await page.getByTestId("upload-input").setInputFiles(image);
  await page
    .getByTestId("upload-input")
    .setInputFiles({ ...image, name: "queued.svg" });
  await page
    .getByRole("button", { name: "Remove First batch", exact: true })
    .click();
  await page
    .getByTestId("upload-input")
    .setInputFiles({ ...image, name: "second.svg" });
  releaseFirst();
  await expect(page.getByText("Uploaded", { exact: true })).toHaveCount(3);
  expect(requests).toHaveLength(3);
  const organization = (body: string) =>
    JSON.parse(body.match(/name="organization"\r\n\r\n([^\r]+)/)![1]!);
  expect(organization(requests[0]!).tagIds).toHaveLength(1);
  expect(organization(requests[1]!).tagIds).toHaveLength(1);
  expect(organization(requests[2]!).tagIds).toHaveLength(0);
});
