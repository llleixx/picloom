import { test, expect, login } from "./fixtures";
test.use({ scenario: "seed" });

test("statistics show additions and drill down to dates, formats, storage and large files on desktop and mobile", async ({
  page,
  service,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page, service.url);
  await page.goto(service.url + "/app/system");
  const panel = page.getByRole("tabpanel", {
    name: "Statistics overview",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "New images", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "25", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Period", exact: true })
    .selectOption("7");
  const bars = panel
    .getByRole("group", { name: "New images", exact: true })
    .getByRole("button");
  await expect(bars).toHaveCount(7);
  await bars.last().click();
  await panel.getByRole("link", { name: "View images →", exact: true }).click();
  await expect(page).toHaveURL(/from=/);
  await expect(page.getByTestId("file-card")).toHaveCount(24);
  await page.goBack();
  await panel.getByRole("link", { name: "PNG", exact: true }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("mimeType") === "image/png",
  );
  await expect(page.getByTestId("file-card")).toHaveCount(24);
  await page.goBack();
  await panel.locator('a[href*="source="]').first().click();
  await expect(page).toHaveURL(/source=/);
  await expect(page.getByTestId("file-card")).toHaveCount(24);
  await page.goBack();
  await panel
    .getByRole("link", { name: "View largest images →", exact: true })
    .click();
  await expect(page).toHaveURL(/sort=size/);
  await expect(page.getByTestId("file-card")).toHaveCount(24);
  await page.goBack();
  await page
    .getByRole("combobox", { name: "Period", exact: true })
    .selectOption("90");
  await expect(bars).toHaveCount(90);
  await panel.getByRole("button", { name: "Size", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "Size", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("format-chart")).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Local storage", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/statistics-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/statistics-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("combobox", { name: "Day", exact: true })
    .selectOption({ index: 90 });
  await expect(
    panel.getByRole("link", { name: "View images →", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("tab", { name: "Maintenance", exact: true }).click();
  await expect(page.getByTestId("service-uptime")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "Maintenance", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test.describe("browser calendar days", () => {
  test.use({ timezoneId: "America/New_York" });
  test("requests local midnights across both DST changes and uses the same detail range", async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    for (const [now, length] of [
      ["2026-03-08T12:00:00-04:00", 23],
      ["2026-11-01T12:00:00-05:00", 25],
    ] as const) {
      await page.clock.setFixedTime(new Date(now));
      const requestPromise = page.waitForRequest((r) =>
        r.url().includes("/api/system/statistics?"),
      );
      await page.goto(service.url + "/app/system");
      const request = await requestPromise;
      const boundaries = new URL(request.url()).searchParams
        .getAll("boundary")
        .map(Number);
      expect(boundaries).toHaveLength(31);
      expect(boundaries.at(-1)! - boundaries.at(-2)!).toBe(length * 3600000);
      const localHours = await page.evaluate(
        (values) => values.map((value) => new Date(value).getHours()),
        boundaries,
      );
      expect(localHours.every((hour) => hour === 0)).toBe(true);
      await page
        .getByRole("group", { name: "New images", exact: true })
        .getByRole("button")
        .last()
        .click();
      const link = page.getByRole("link", {
        name: "View images →",
        exact: true,
      });
      const url = new URL((await link.getAttribute("href"))!, service.url);
      const dates = await page.evaluate(
        (values) =>
          values.map((value) => {
            const d = new Date(value);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          }),
        [boundaries.at(-2)!, boundaries.at(-1)! - 1],
      );
      expect(url.searchParams.get("from")).toBe(dates[0]);
      expect(url.searchParams.get("to")).toBe(dates[1]);
    }
  });
});
