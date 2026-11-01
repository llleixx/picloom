import { test, expect, login } from "./fixtures";
import sharp from "sharp";

test.use({ scenario: "seed" });
for (const postSave of [false, true]) {
  test(`replace from image details keeps the link${postSave ? " after post-save replacement" : ""}`, async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    const files = await (
      await page.request.get(service.url + "/api/files")
    ).json();
    const old = Array.isArray(files) ? files[0] : files.items[0];
    if (postSave) {
      const session = await (
        await page.request.get(service.url + "/api/auth/session")
      ).json();
      const headers = { "X-CSRF-Token": session.csrfToken };
      const pipeline = await page.request.post(service.url + "/api/pipelines", {
        headers,
        data: {
          name: "Background resize",
          kind: "post_save",
          steps: [
            {
              pluginId: "builtin.sharp",
              version: "1.0.0",
              config: { w: 8, format: "webp" },
            },
          ],
        },
      });
      expect(pipeline.status()).toBe(201);
      const profiles = await (
        await page.request.get(service.url + "/api/upload-profiles")
      ).json();
      const editor = await (
        await page.request.get(
          `${service.url}/api/upload-profiles/${profiles[0].id}`,
        )
      ).json();
      const updated = await page.request.put(
        `${service.url}/api/upload-profiles/${editor.id}`,
        {
          headers,
          data: {
            ...editor,
            expectedVersion: editor.configVersion,
            postSavePipelineId: (await pipeline.json()).id,
          },
        },
      );
      expect(updated.status()).toBe(200);
    }
    await page.goto(`${service.url}/app/images?file=${old.id}`);
    await page
      .getByRole("button", { name: "Replace image", exact: true })
      .click();
    const dialog = page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "Replace image", exact: true }),
    });
    const buffer = await sharp({
      create: { width: 17, height: 9, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({
        name: "replacement.png",
        mimeType: "image/png",
        buffer,
      });
    const completed = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/files/${old.id}/replace`) &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Replace image", exact: true })
      .click();
    const response = await completed;
    expect(response.status()).toBe(200);
    const result = await response.json();
    expect(result.id).not.toBe(old.id);
    expect(new URL(result.url).pathname).toBe(new URL(old.url).pathname);
    await expect(page).toHaveURL(new RegExp(`file=${result.id}`));
    await expect(
      page.getByRole("button", { name: "Replace image", exact: true }),
    ).toBeVisible();
    const image = await page.request.get(result.url);
    expect(image.ok()).toBe(true);
    if (postSave) {
      expect(await sharp(await image.body()).metadata()).toMatchObject({
        width: 8,
        format: "webp",
      });
    } else {
      expect(await image.body()).toEqual(buffer);
    }
  });
}
