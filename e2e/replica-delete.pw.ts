import { test, expect, login } from "./fixtures";
import sharp from "sharp";
test("source filter and default last-copy deletion", async ({
  page,
  service,
}) => {
  await login(page, service.url);
  const session = await (
    await page.request.get(service.url + "/api/auth/session")
  ).json();
  const headers = { "x-csrf-token": session.csrfToken, origin: service.url };
  const source = await (
    await page.request.post(service.url + "/api/storage-sources", {
      headers,
      data: {
        pluginId: "builtin.local",
        version: "1.0.0",
        name: "Extra copy",
        config: { root: service.root + "/extra" },
        secretEdits: {},
      },
    })
  ).json();
  const profiles = await (
    await page.request.get(service.url + "/api/upload-profiles")
  ).json();
  const profile = await (
    await page.request.get(
      service.url + "/api/upload-profiles/" + profiles[0].id,
    )
  ).json();
  const group = await (
    await page.request.get(
      service.url + "/api/storage-groups/" + profile.storageGroupId,
    )
  ).json();
  expect(
    (
      await page.request.put(service.url + "/api/storage-groups/" + group.id, {
        headers,
        data: {
          ...group,
          members: [...group.members, { instanceId: source.id, weight: 1 }],
          replicaCount: 2,
          expectedVersion: group.configVersion,
        },
      })
    ).ok(),
  ).toBeTruthy();
  const bytes = await sharp({
    create: { width: 40, height: 40, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const image = await (
    await page.request.post(service.url + "/api/files", {
      headers,
      multipart: {
        profileId: profile.id,
        file: { name: "sample.png", mimeType: "image/png", buffer: bytes },
      },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(
              `${service.url}/api/files/${image.id}/operations`,
            )
          ).json()
        ).replicas.filter((r: any) => r.status === "ready").length,
    )
    .toBe(2);
  await page.reload();
  await page
    .getByLabel("Storage Source", { exact: true })
    .selectOption(source.id);
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel("Storage Source", { exact: true })).toHaveValue(
    source.id,
  );
  await page
    .getByTestId("file-card")
    .getByRole("button", { name: /^Open / })
    .click();
  const row = page
    .locator("div.rounded-lg.border.p-3")
    .filter({ hasText: "Extra copy" })
    .first();
  await row.getByRole("button", { name: "Delete Replica" }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete replica?", exact: true }),
  ).toContainText("Delete storage files");
  await page
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(row).toContainText("Removed");
  expect(
    (await page.request.get(service.url + new URL(image.url).pathname)).ok(),
  ).toBeTruthy();
  // Removing an unused configuration preserves its completed replica and tasks.
  const updatedGroup = await (
    await page.request.get(service.url + "/api/storage-groups/" + group.id)
  ).json();
  expect(
    (
      await page.request.put(service.url + "/api/storage-groups/" + group.id, {
        headers,
        data: {
          ...updatedGroup,
          members: group.members,
          replicaCount: 1,
          expectedVersion: updatedGroup.configVersion,
        },
      })
    ).ok(),
  ).toBeTruthy();
  const beforeRemoval = await (
    await page.request.get(`${service.url}/api/files/${image.id}/operations`)
  ).json();
  expect(
    (
      await page.request.delete(
        `${service.url}/api/storage-sources/${source.id}`,
        { headers },
      )
    ).ok(),
  ).toBeTruthy();
  const history = await (
    await page.request.get(`${service.url}/api/files/${image.id}/operations`)
  ).json();
  expect(history.tasks).toHaveLength(beforeRemoval.tasks.length);
  expect(history.replicas).toHaveLength(beforeRemoval.replicas.length);
  expect(
    history.replicas.find((replica: any) => replica.instanceId === source.id),
  ).toMatchObject({
    status: "deleted",
    instanceDeleted: true,
    name: source.id,
  });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // The source was removed through the API, outside this page's query cache.
  await page.reload();
  await page
    .getByLabel("Storage Source", { exact: true })
    .selectOption(group.members[0].instanceId);
  await page
    .getByTestId("file-card")
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(
    page.getByText(`Deleted storage source · ${source.id}`, { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("file-card")).toHaveCount(1);
  await page.getByTestId("file-card").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Delete selected replicas", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Operation")).toHaveValue("delete");
  await expect(dialog.getByLabel("Scope")).toHaveValue("false");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();

  await dialog
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(page.getByTestId("file-card")).toHaveCount(0);
  expect(
    (
      await page.request.get(service.url + new URL(image.url).pathname)
    ).status(),
  ).toBe(404);
});

for (const operation of [
  "replica-delete",
  "source-detail-delete",
  "replica-detach",
] as const) {
  test(`single last-replica ${operation} includes the last copy without a preserve control`, async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    const session = await (
      await page.request.get(service.url + "/api/auth/session")
    ).json();
    const headers = { "x-csrf-token": session.csrfToken, origin: service.url };
    const profiles = await (
      await page.request.get(service.url + "/api/upload-profiles")
    ).json();
    const bytes = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const image = await (
      await page.request.post(service.url + "/api/files", {
        headers,
        multipart: {
          profileId: profiles[0].id,
          file: { name: "single.png", mimeType: "image/png", buffer: bytes },
        },
      })
    ).json();
    let replicas: Array<{ id: string; instanceId: string; status: string }> =
      [];
    await expect
      .poll(async () => {
        replicas = (
          await (
            await page.request.get(
              `${service.url}/api/files/${image.id}/operations`,
            )
          ).json()
        ).replicas;
        return replicas.filter((replica) => replica.status === "ready").length;
      })
      .toBe(1);
    const replica = replicas[0]!;
    const sourceFiltered = operation !== "replica-delete";
    await page.goto(
      `${service.url}/app/images?file=${image.id}${sourceFiltered ? `&source=${replica.instanceId}` : ""}`,
    );
    const entry =
      operation === "source-detail-delete"
        ? page
            .getByRole("button", { name: "Delete Replica", exact: true })
            .first()
        : page
            .locator("div.rounded-lg.border.p-3")
            .getByRole("button", { name: "Delete Replica", exact: true });
    await entry.click();
    const dialog = page.getByRole("dialog", {
      name: /^(Delete|Detach) (replica|image)\?$/,
    });
    await expect(dialog).toHaveAccessibleName("Delete replica?");
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    if (operation === "source-detail-delete") {
      await dialog.getByLabel("Scope").selectOption("true");
      await expect(dialog).toHaveAccessibleName("Delete image?");
      await expect(dialog).toContainText(
        "Delete storage files",
      );
      await dialog.getByLabel("Operation").selectOption("detach");
      await expect(dialog).toHaveAccessibleName("Detach image?");
      await expect(
        dialog.getByRole("button", { name: "Confirm detach", exact: true }),
      ).toBeEnabled();
      await dialog.getByLabel("Operation").selectOption("delete");
      await dialog.getByLabel("Scope").selectOption("false");
      await expect(dialog).toHaveAccessibleName("Delete replica?");
    }
    await expect(dialog).not.toContainText("With another available replica");
    await expect(dialog.locator("p.subtle")).toHaveCount(1);
    if (operation === "replica-detach") {
      await dialog.getByLabel("Operation").selectOption("detach");
      await expect(dialog).toHaveAccessibleName("Detach replica?");
    }
    const action = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return operation === "source-detail-delete"
        ? url.pathname === "/api/files/batch-delete" &&
            request.method() === "POST"
        : url.pathname ===
            `/api/files/${image.id}/replicas/${replica.id}${operation === "replica-detach" ? "/detach" : ""}` &&
            request.method() ===
              (operation === "replica-detach" ? "POST" : "DELETE");
    });
    await dialog
      .getByRole("button", {
        name:
          operation === "replica-detach" ? "Confirm detach" : "Confirm delete",
        exact: true,
      })
      .click();
    const request = await action;
    if (operation === "replica-delete")
      expect(new URL(request.url()).searchParams.get("includeLast")).toBe(
        "true",
      );
    else expect(request.postDataJSON().includeLast).toBe(true);
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(async () =>
        (
          await page.request.get(service.url + new URL(image.url).pathname)
        ).status(),
      )
      .toBe(404);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(`${service.url}/api/files/${image.id}`)
            ).json()
          ).status,
      )
      .toBe("deleted");
  });
}

for (const scope of ["images", "replicas"] as const) {
  test(`bulk ${scope} detach uses its submitted operation and counts preserved replicas separately`, async ({
    page,
    service,
  }) => {
    await login(page, service.url);
    const session = await (
      await page.request.get(service.url + "/api/auth/session")
    ).json();
    const headers = { "x-csrf-token": session.csrfToken, origin: service.url };
    const profiles = await (
      await page.request.get(service.url + "/api/upload-profiles")
    ).json();
    const bytes = await sharp({
      create: { width: 30, height: 30, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const ids: string[] = [];
    for (let index = 0; index < 2; index++) {
      const image = await (
        await page.request.post(service.url + "/api/files", {
          headers,
          multipart: {
            profileId: profiles[0].id,
            file: {
              name: `bulk-${index}.png`,
              mimeType: "image/png",
              buffer: bytes,
            },
          },
        })
      ).json();
      ids.push(image.id);
    }
    const operations = await (
      await page.request.get(`${service.url}/api/files/${ids[0]}/operations`)
    ).json();
    const sourceId = operations.replicas[0].instanceId;
    await page.goto(
      service.url +
        "/app/images" +
        (scope === "replicas" ? `?source=${sourceId}` : ""),
    );
    await expect(page.getByTestId("file-card")).toHaveCount(2);
    for (const card of await page.getByTestId("file-card").all())
      await card.getByRole("checkbox").check();
    const open = async () => {
      await page
        .getByRole("button", {
          name:
            scope === "replicas"
              ? "Delete selected replicas"
              : "Delete selected",
          exact: true,
        })
        .click();
      return page.getByRole("dialog");
    };
    let dialog = await open();
    await expect(dialog).toHaveAccessibleName(`Delete 2 ${scope}?`);
    await expect(dialog.locator("p.subtle")).toHaveCount(1);
    if (scope === "replicas") {
      await dialog.getByRole("checkbox").check();
      const preserved = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === "/api/files/batch-delete" &&
          request.method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "Confirm delete", exact: true })
        .click();
      expect((await preserved).postDataJSON()).toMatchObject({
        ids: expect.arrayContaining(ids),
        sourceId,
        includeLast: false,
      });
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByText("Replica deletion requested: 0. Kept: 2. Failed: 0.", {
          exact: true,
        }),
      ).toBeVisible();
      dialog = await open();
    }
    await dialog.getByLabel("Operation").selectOption("detach");
    await expect(dialog).toHaveAccessibleName(`Detach 2 ${scope}?`);
    if (scope === "replicas") {
      await expect(
        page.getByText("Replica deletion requested: 0. Kept: 2. Failed: 0.", {
          exact: true,
        }),
      ).toBeVisible();
      await dialog.getByLabel("Scope").selectOption("true");
      await expect(dialog).toHaveAccessibleName("Detach 2 images?");
      await dialog.getByLabel("Scope").selectOption("false");
      await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/files/batch-detach", async (route) => {
      await held;
      await route.continue();
    });
    const submitted = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/files/batch-detach" &&
        request.method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Confirm detach", exact: true })
      .click();
    try {
      const payload = (await submitted).postDataJSON();
      expect([...payload.ids].sort()).toEqual([...ids].sort());
      expect(payload.confirm).toBe(true);
      if (scope === "replicas")
        expect(payload).toMatchObject({ sourceId, includeLast: true });
      else expect(payload.sourceId).toBeUndefined();
      await expect(dialog.getByLabel("Operation")).toBeDisabled();
      if (scope === "replicas") {
        await expect(dialog.getByLabel("Scope")).toBeDisabled();
        await expect(dialog.getByRole("checkbox")).toBeDisabled();
      }
      await expect(dialog).toHaveAccessibleName(`Detach 2 ${scope}?`);
      await expect(
        dialog.getByRole("button", { name: "Detaching…", exact: true }),
      ).toBeVisible();
    } finally {
      release();
    }
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText(
        `${scope === "replicas" ? "Replicas" : "Images"} detached: 2. Kept: 0. Failed: 0.`,
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByTestId("file-card")).toHaveCount(0);
    for (const id of ids)
      expect(
        (
          await (
            await page.request.get(`${service.url}/api/files/${id}`)
          ).json()
        ).status,
      ).toBe("deleted");
  });
}
