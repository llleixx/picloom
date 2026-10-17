import { test, expect, login } from "./fixtures";

test("Tencent Cloud Post-save form saves encrypted credentials without submitting images", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Pipeline name").fill("Tencent review");
  await page.getByLabel("Pipeline type").selectOption("post_save");
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page
    .getByLabel("Processor plugin")
    .selectOption("builtin.tencent-moderation@1.0.0");
  await page.getByLabel("Secret ID", { exact: true }).fill("test-id");
  await page.getByLabel("Secret key", { exact: true }).fill("test-secret");
  await page.getByLabel("BizType", { exact: true }).fill("test");
  await expect(
    page.getByLabel("Submission method", { exact: true }),
  ).toHaveValue(JSON.stringify("content"));
  await page
    .getByLabel("Submission method", { exact: true })
    .selectOption({ label: "Public URL" });
  await expect(page.getByLabel("On violation", { exact: true })).toHaveValue(
    JSON.stringify("block"),
  );
  await expect(
    page.getByLabel("Timeout (ms)", { exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Show advanced", exact: true })
    .click();
  await expect(page.getByLabel("Region", { exact: true })).toHaveValue(
    "ap-guangzhou",
  );
  await expect(
    page.getByLabel("Maximum GIF frames", { exact: true }),
  ).toHaveValue("5");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const response = await page.request.get(service.url + "/api/pipelines");
  const pipelines = await response.json();
  const chain = pipelines.find((p: any) => p.name === "Tencent review");
  expect(chain.steps[0].config.bizType).toBe("test");
  expect(chain.steps[0].config.submissionMode).toBe("url");
  expect(JSON.stringify(chain)).not.toContain("test-secret");
  expect(chain.steps[0].config.secretKey).toBeUndefined();
});
