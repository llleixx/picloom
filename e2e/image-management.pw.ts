import {
  test,
  expect,
  login,
  openImageFilters,
  closeImageFilters,
  openBatchRemoval,
} from "./fixtures";
test.use({ scenario: "seed" });
test("applied filters, compact cards and mobile filter sheet", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const tags = [];
  for (const name of [
    "Product",
    "Homepage",
    "A long tag name for checking compact cards",
    "Summer",
  ]) {
    tags.push(
      await (
        await page.request.post(service.url + "/api/tags", {
          headers,
          data: { name },
        })
      ).json(),
    );
  }
  const collection = await (
    await page.request.post(service.url + "/api/collections", {
      headers,
      data: { name: "Website assets" },
    })
  ).json();
  const files = await (
    await page.request.get(service.url + "/api/files?limit=1")
  ).json();
  for (const [kind, ids] of [
    ["tags", tags.map((tag) => tag.id)],
    ["collections", [collection.id]],
  ] as const) {
    expect(
      (
        await page.request.post(service.url + `/api/files/batch-${kind}`, {
          headers,
          data: { ids: [files[0].id], add: ids, remove: [] },
        })
      ).ok(),
    ).toBe(true);
  }
  await page.goto(
    service.url + `/app/images?tag=${tags[0].id}&collection=${collection.id}`,
  );
  const cards = page.getByTestId("file-card");
  const scope = page.getByRole("combobox", {
    name: "Image scope",
    exact: true,
  });
  await expect(scope).toHaveValue("mine");
  await expect(cards.getByText("admin", { exact: true })).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await expect(cards.getByText("+2", { exact: true })).toBeVisible();
  await expect(cards.getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Remove filter: Product", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove filter: Website assets",
      exact: true,
    }),
  ).toBeVisible();
  await openImageFilters(page);
  await page
    .getByLabel("Image type", { exact: true })
    .selectOption("image/png");
  await page.getByLabel("Order", { exact: true }).selectOption("asc");
  await closeImageFilters(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Remove filter: PNG", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove filter: Oldest first",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove filter: Product", exact: true })
    .click();
  await expect(page).not.toHaveURL(/tag=/);
  await expect(
    page.getByRole("button", {
      name: "Remove filter: Website assets",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(cards).toHaveCount(24);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if ((await scope.inputValue()) !== "mine") await scope.selectOption("mine");
    await openImageFilters(page);
    const panel = page.getByRole("dialog", {
      name: "Filters & sort",
      exact: true,
    });
    await expect(
      panel.getByRole("combobox", { name: "Owner", exact: true }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("combobox", { name: "Storage Source", exact: true }),
    ).toHaveCount(0);
    const box = await panel.boundingBox();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(width);
    expect(box!.y + box!.height).toBe(844);
    await panel.getByRole("button", { name: "Add tags", exact: true }).click();
    await panel.getByLabel("Search tags", { exact: true }).fill("Product");
    await panel.getByRole("button", { name: "Product", exact: true }).click();
    await panel.getByRole("button", { name: "Add tags", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await closeImageFilters(page);
    await expect(cards).toHaveCount(1);
    await page
      .getByRole("button", { name: "Remove filter: Product", exact: true })
      .click();
    await expect(cards).toHaveCount(24);
    await scope.selectOption("all");
    await expect(
      cards.first().getByText("admin", { exact: true }),
    ).toBeVisible();
    await openImageFilters(page);
    await expect(
      panel.getByRole("button", { name: "Add tags", exact: true }),
    ).toHaveCount(0);
    const owner = panel.getByRole("combobox", { name: "Owner", exact: true });
    await owner.click();
    await owner.fill("adm");
    await panel.getByRole("option", { name: "admin", exact: true }).click();
    await expect(owner).toHaveValue("admin");
    await closeImageFilters(page);
    await page
      .getByRole("button", { name: "Remove filter: Owner: admin", exact: true })
      .click();
    await openImageFilters(page);
    await owner.click();
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.style.overflow),
    ).not.toBe("hidden");
  }
});
test("dates, cross-page selection, copying, bulk deletion and detail navigation", async ({
  page,
  service,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as any).copied = text;
        },
      },
    });
  });
  await login(page, service.url);
  const cards = page.getByTestId("file-card");
  await expect(cards).toHaveCount(24);
  await openImageFilters(page);
  await page.getByLabel("Upload time", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill("2000-01-01");
  await page.getByLabel("Through", { exact: true }).fill("2000-01-02");
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await closeImageFilters(page);
  await expect(
    page.getByRole("heading", { name: "No images found" }),
  ).toBeVisible();
  await page.reload();
  await openImageFilters(page);
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "2000-01-01",
  );
  await page.getByLabel("Upload time", { exact: true }).selectOption("all");
  await closeImageFilters(page);
  await expect(cards).toHaveCount(24);
  await cards.first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await cards.first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Copy format", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Markdown", exact: true })
    .click();
  await page.getByRole("button", { name: "Copy links", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).copied?.split("\n").length))
    .toBe(2);
  await cards
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(
    page.getByRole("button", { name: "Next image", exact: true }),
  ).toBeDisabled();
  const detailUrl = page.url();
  await page.getByLabel("Access link", { exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  expect(page.url()).toBe(detailUrl);
  await page
    .getByRole("button", { name: "Previous image", exact: true })
    .click();
  await expect(page).toHaveURL(/page=1/);
  await page.getByRole("button", { name: "Next image", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/page=2/);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
  await openBatchRemoval(page);
  await expect(page.getByRole("dialog")).toContainText("Delete 2 images?");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByText("Image deletion requested: 2. Kept: 0. Failed: 0.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(cards).toHaveCount(23);
  await page
    .getByRole("checkbox", { name: "Select page", exact: true })
    .check();
  await expect(page.getByText("23 selected", { exact: true })).toBeVisible();
  await openImageFilters(page);
  await page.getByLabel("Upload time", { exact: true }).selectOption("7");
  await closeImageFilters(page);
  await expect(
    page.getByRole("button", { name: "Clear selection", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("partial batch failure retains failed selections for retry", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const cards = page.getByTestId("file-card");
  await cards.nth(0).getByRole("checkbox").check();
  await cards.nth(1).getByRole("checkbox").check();
  await page.route("**/api/files/batch-delete", async (route) => {
    const { ids } = route.request().postDataJSON();
    const actual = await route.fetch({
      postData: JSON.stringify({ ids: [ids[1]] }),
    });
    const data = await actual.json();
    await route.fulfill({
      response: actual,
      json: {
        results: [
          { id: ids[0], accepted: false, error: "INTERNAL" },
          ...data.results,
        ],
      },
    });
  });
  await openBatchRemoval(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByText("Image deletion requested: 1. Kept: 0. Failed: 1.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.unroute("**/api/files/batch-delete");
  await openBatchRemoval(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    page.getByText("Image deletion requested: 1. Kept: 0. Failed: 0.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear selection", exact: true }),
  ).toHaveCount(0);
});
