import { test, expect, login } from "./fixtures";
test.use({ scenario: "seed" });
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
  await page.getByLabel("Upload time", { exact: true }).selectOption("custom");
  await page.getByLabel("From", { exact: true }).fill("2000-01-01");
  await page.getByLabel("Through", { exact: true }).fill("2000-01-02");
  await page.getByRole("button", { name: "Apply dates", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No images found" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue(
    "2000-01-01",
  );
  await page.getByLabel("Upload time", { exact: true }).selectOption("all");
  await expect(cards).toHaveCount(24);
  await cards.first().getByRole("checkbox").check();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await cards.first().getByRole("checkbox").check();
  await page
    .getByLabel("Copy format", { exact: true })
    .selectOption("Markdown");
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
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Delete 2 images?");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(
    page.getByText("Deletion requested: 2. Failed: 0.", { exact: true }),
  ).toBeVisible();
  await expect(cards).toHaveCount(23);
  await page
    .getByRole("checkbox", { name: "Select page", exact: true })
    .check();
  await expect(page.getByText("23 selected", { exact: true })).toBeVisible();
  await page.getByLabel("Upload time", { exact: true }).selectOption("7");
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
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(
    page.getByText("Deletion requested: 1. Failed: 1.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.unroute("**/api/files/batch-delete");
  await page
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(
    page.getByText("Deletion requested: 1. Failed: 0.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear selection", exact: true }),
  ).toHaveCount(0);
});
