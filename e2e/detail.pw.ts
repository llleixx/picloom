import { test, expect, login, expandDetails } from "./fixtures";
test.use({ scenario: "seed" });

test("compact detail keeps links, editable organization and fixed mobile controls", async ({
  page,
  context,
  service,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const tag = await (
    await page.request.post(service.url + "/api/tags", {
      headers,
      data: { name: "Product photos" },
    })
  ).json();
  const files = await (
    await page.request.get(service.url + "/api/files?limit=1")
  ).json();
  const file = files[0];
  expect(
    (
      await page.request.post(service.url + "/api/files/batch-tags", {
        headers,
        data: { ids: [file.id], add: [tag.id], remove: [] },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(service.url + `/app/images?file=${file.id}`);
  const detail = page.getByRole("dialog");
  const link = detail.getByLabel("Access link", { exact: true });
  await expect(link).toHaveValue(file.url);
  const information = page.getByTestId("file-information");
  const storage = page.getByTestId("file-storage");
  const processing = page.getByTestId("file-processing");
  await expect(information).toHaveJSProperty("open", true);
  await expect(storage).toHaveJSProperty("open", true);
  await expect(processing).toHaveJSProperty("open", true);
  await expect(
    detail.getByRole("button", { name: "Remove Product photos", exact: true }),
  ).toHaveCount(0);
  await detail
    .getByRole("button", { name: "Copy format", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "Markdown", exact: true })
    .click();
  await expect(link).toHaveValue(`![](${file.url})`);
  await detail
    .getByRole("button", { name: "Copy Markdown", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`![](${file.url})`);
  await detail
    .getByRole("button", { name: "Copy format", exact: true })
    .click();
  await page.getByRole("menuitemradio", { name: "URL", exact: true }).click();
  await expandDetails(page, "link-parameters");
  await detail
    .getByRole("button", { name: "Add parameter", exact: true })
    .click();
  await detail.getByRole("button", { name: /^Width\s/ }).click();
  await detail.getByLabel("Width", { exact: true }).fill("20");
  await page.getByTestId("link-parameters").locator("summary").first().click();
  await expect(link).toHaveValue(file.url + "?w=20");
  await expect(
    detail.getByRole("link", { name: "Open link", exact: true }),
  ).toHaveAttribute("href", file.url + "?w=20");
  await expandDetails(page, "link-parameters");
  await detail
    .getByRole("button", { name: "Clear parameters", exact: true })
    .click();
  await expect(link).toHaveValue(file.url);
  await page.getByTestId("link-parameters").locator("summary").first().click();
  await detail
    .getByRole("button", { name: "Edit organization", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Remove Product photos", exact: true })
    .click();
  await detail.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    detail.getByText("Product photos", { exact: true }),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: "Edit organization", exact: true })
    .click();
  await detail
    .getByRole("button", { name: "Remove Product photos", exact: true })
    .click();
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await expect(detail.getByText("Product photos", { exact: true })).toHaveCount(
    0,
  );
  const updated = await (
    await page.request.get(service.url + `/api/files/${file.id}`)
  ).json();
  expect(updated.tags).toEqual([]);
  await expandDetails(page, "file-information");
  await detail.getByRole("button", { name: "Copy ID", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(file.id);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const header = detail.locator("header");
    const footer = page.getByTestId("detail-actions");
    const headerBefore = await header.boundingBox();
    const footerBefore = await footer.boundingBox();
    await page
      .getByTestId("detail-body")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect((await header.boundingBox())!.y).toBe(headerBefore!.y);
    expect((await footer.boundingBox())!.y).toBe(footerBefore!.y);
    expect(footerBefore!.y + footerBefore!.height).toBe(844);
    expect(
      await detail.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await expect(
      detail.getByRole("button", { name: "Delete image", exact: true }),
    ).toBeVisible();
    await detail.getByRole("button", { name: "Add tags", exact: true }).click();
    await expect(
      detail.getByLabel("Search tags", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeVisible();
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();
  }
});
