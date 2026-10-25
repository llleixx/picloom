import { expect, test } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { hash } from "../src/core/auth";
import type {
  UploadPlugin,
  PostSavePlugin,
  PathPlugin,
} from "../src/plugins/api";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const metadata = (id: string) => ({
  id,
  kind: "processor" as const,
  version: "1",
  apiVersion: 1 as const,
  defaultLocale: "en-US",
  nameKey: "name",
  messages: { "en-US": { name: id } },
});
const schema = { type: "object" as const, properties: {} };
async function configure(
  f: Fixture,
  uploads: UploadPlugin[] = [],
  posts: PostSavePlugin[] = [],
  path?: PathPlugin,
) {
  const uploadIds = uploads.map((plugin, i) => {
    const id = `test.organization-upload-${i}`;
    f.app.plugins.register({
      ...metadata(id),
      stages: {
        upload: {
          configSchemaVersion: 1,
          configSchema: schema,
          async createInstance() {
            return plugin;
          },
        },
      },
    });
    return id;
  });
  const postIds = posts.map((plugin, i) => {
    const id = `test.organization-post-${i}`;
    f.app.plugins.register({
      ...metadata(id),
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: schema,
          async createInstance() {
            return plugin;
          },
        },
      },
    });
    return id;
  });
  if (path)
    f.app.plugins.register({
      ...metadata("test.organization-path"),
      kind: "path",
      configSchemaVersion: 1,
      configSchema: schema,
      async createInstance() {
        return path;
      },
    });
  const steps = (ids: string[], post = false) =>
    ids.map((pluginId) => ({
      pluginId,
      version: "1",
      config: {},
      ...(post ? {} : { onNotApplicable: "abort" as const }),
    }));
  const upload = uploads.length
    ? await f.app.configuration.savePipeline({
        name: "Organize upload",
        kind: "upload",
        steps: steps(uploadIds),
      })
    : null;
  const post = posts.length
    ? await f.app.configuration.savePipeline({
        name: "Organize saved",
        kind: "post_save",
        steps: steps(postIds, true),
      })
    : null;
  const profile = await f.app.configuration.profileEditor(f.profileId);
  await f.app.configuration.saveProfileEditor(
    {
      ...profile,
      uploadPipelineId: upload?.id ?? null,
      postSavePipelineId: post?.id ?? null,
      ...(path
        ? {
            path: {
              pluginId: "test.organization-path",
              version: "1",
              config: {},
            },
          }
        : {}),
      expectedVersion: profile.configVersion,
    },
    profile.id,
  );
}
function form(f: Fixture, organization?: unknown) {
  const data = new FormData();
  data.set("profileId", f.profileId);
  data.set("file", new File([new Uint8Array(f.png)], "image.png"));
  if (organization !== undefined)
    data.set("organization", JSON.stringify(organization));
  return data;
}
async function create(
  f: Fixture,
  kind: "tags" | "collections",
  input: Record<string, unknown>,
) {
  const response = await f.request(`/api/${kind}`, "POST", input);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}
const applicable = async () => ({ status: "applicable" as const });
async function relations(f: Fixture, id: string) {
  return f.app.db.read((r) => f.app.organization.read(r, id));
}
async function chunk(f: Fixture, organization: unknown) {
  const response = await f.request("/api/uploads", "POST", {
    profileId: f.profileId,
    size: f.png.length,
    name: "chunk.png",
    organization,
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as { id: string; uploadKey: string };
  const put = await handler(f.app)(
    new Request(`http://localhost/api/uploads/${created.id}/parts/0`, {
      method: "PUT",
      headers: { "x-upload-key": created.uploadKey },
      body: new Uint8Array(f.png),
    }),
  );
  expect(put.status).toBe(200);
  return created;
}

test("upload ensure updates flow to the next step and path; post-save organization keeps the generated path", async () => {
  const f = await fixture();
  try {
    let uploadTag = "",
      uploadCollection = "",
      savedTag = "",
      pathCalled = 0,
      observed = 0;
    await configure(
      f,
      [
        {
          check: applicable,
          async process(input, ctx) {
            const tag = await ctx.organization.ensureTag({
                name: "Upload label",
              }),
              collection = await ctx.organization.ensureCollection({
                name: "Upload album",
              });
            uploadTag = tag.id;
            uploadCollection = collection.id;
            expect(input.record.organization.tags).toEqual([]);
            return {
              status: "pass",
              organization: {
                tagIds: [tag.id],
                collectionIds: [collection.id],
              },
            };
          },
        },
        {
          async check(input, ctx) {
            expect(input.record.organization.tags.map((x) => x.id)).toEqual([
              uploadTag,
            ]);
            expect(
              (await ctx.organization.listCollections()).items.map((x) => x.id),
            ).toContain(uploadCollection);
            observed++;
            return { status: "applicable" };
          },
          async process(input) {
            expect(
              input.record.organization.collections.map((x) => x.id),
            ).toEqual([uploadCollection]);
            observed++;
            return { status: "pass" };
          },
        },
      ],
      [
        {
          async execute(input, ctx) {
            expect(input.record.organization.tags.map((x) => x.id)).toEqual([
              uploadTag,
            ]);
            const tag = await ctx.organization.ensureTag({
              name: "Saved label",
            });
            savedTag = tag.id;
            return { organization: { tagIds: [tag.id] } };
          },
        },
      ],
      {
        async generate(input) {
          pathCalled++;
          expect(input.record.organization.tags.map((x) => x.id)).toEqual([
            uploadTag,
          ]);
          expect(
            input.record.organization.collections.map((x) => x.id),
          ).toEqual([uploadCollection]);
          return { logicalKey: `organized/${input.record.id}.png` };
        },
      },
    );
    const response = await f.upload();
    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as { id: string; url: string };
    await f.app.files.sweep();
    const file = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    expect(observed).toBe(2);
    expect(pathCalled).toBe(1);
    expect(file.logical_key).toBe(`organized/${uploaded.id}.png`);
    expect(new URL(uploaded.url).pathname).toEndWith(file.logical_key);
    const organized = await relations(f, file.id);
    expect(organized.tags.map((x) => x.id)).toEqual([savedTag]);
    expect(organized.collections.map((x) => x.id)).toEqual([uploadCollection]);
  } finally {
    await f.close();
  }
});

test("invalid post-save organization rejects its disposition while retaining accepted prior changes", async () => {
  const f = await fixture();
  try {
    const tag = await create(f, "tags", { name: "Accepted" }),
      collection = await create(f, "collections", { name: "Initial" });
    await configure(
      f,
      [],
      [
        {
          async execute() {
            return {
              organization: { tagIds: [tag.id] },
              disposition: { value: "block" },
            };
          },
        },
        {
          async execute(input) {
            expect(input.currentDisposition).toBe("block");
            expect(input.record.organization.tags.map((x) => x.id)).toEqual([
              tag.id,
            ]);
            return {
              organization: { collectionIds: ["missing"] },
              disposition: { value: "delete" },
            };
          },
        },
      ],
    );
    const response = await f.request(
      "/api/files",
      "POST",
      form(f, { collectionIds: [collection.id] }),
    );
    expect(response.status).toBe(201);
    const uploaded = (await response.json()) as { id: string };
    await f.app.files.sweep();
    const file = (await f.app.db.read((r) => r.file(uploaded.id)))!;
    expect(file.status).toBe("blocked");
    expect(file.processing_results_json).toHaveLength(1);
    expect(file.processing_results_json?.[0]?.disposition).toEqual({
      value: "block",
      mode: "escalate",
    });
    expect((await relations(f, file.id)).tags.map((x) => x.id)).toEqual([
      tag.id,
    ]);
    expect((await relations(f, file.id)).collections.map((x) => x.id)).toEqual([
      collection.id,
    ]);
    const task = (await f.app.db.read((r) => r.tasks(file.id))).find(
      (x) => x.kind === "action",
    )!;
    expect(task.status).toBe("failed");
    expect(task.next_run_at).toBeNull();
  } finally {
    await f.close();
  }
});

test("upload ownership stays with the uploader and guests cannot select organization", async () => {
  const f = await fixture();
  try {
    const added = await f.request("/api/users", "POST", {
      username: "member",
      password: "member-password",
      role: "member",
      profileIds: [f.profileId],
    });
    expect(added.status).toBe(201);
    const member = (await added.json()) as { id: string };
    const foreign = await create(f, "tags", {
      name: "Member label",
      ownerId: member.id,
    });
    // Even an administrator's ordinary upload stays in the administrator's owner scope.
    expect(
      (await f.request("/api/files", "POST", form(f, { tagIds: [foreign.id] })))
        .status,
    ).toBe(400);
    const profile = (await f.app.db.read((r) => r.profile(f.profileId)))!;
    await f.app.db.transaction((r) =>
      r.saveProfile(
        {
          ...profile,
          allow_guest_upload: true,
          config_version: profile.config_version + 1,
        },
        profile.config_version,
      ),
    );
    const guest = await handler(f.app)(
      new Request("http://localhost/api/files", {
        method: "POST",
        body: form(f, { tagIds: [foreign.id] }),
      }),
      "203.0.113.9",
    );
    expect(guest.status).toBe(403);
    const own = await create(f, "tags", { name: "Admin label" });
    const tokenResponse = await f.request("/api/tokens", "POST", {
      name: "upload",
      profileIds: [f.profileId],
    });
    const token = (await tokenResponse.json()) as { token: string };
    const uploaded = await f.request(
      "/api/files",
      "POST",
      form(f, { tagIds: [own.id] }),
      token.token,
    );
    expect(uploaded.status).toBe(201);
    const image = (await uploaded.json()) as { id: string };
    expect((await relations(f, image.id)).tags.map((x) => x.id)).toEqual([
      own.id,
    ]);
    expect(
      (await f.request("/api/tags", "GET", undefined, token.token)).ok,
    ).toBe(false);
    for (const kind of ["tags", "collections"]) {
      expect(
        (
          await f.request(`/api/${kind}`, "POST", {
            name: "Guest",
            ownerId: null,
          })
        ).status,
      ).toBe(400);
      expect((await f.request(`/api/${kind}?owner=guest`)).status).toBe(404);
    }
    await configure(
      f,
      [
        {
          check: applicable,
          async process(input, ctx) {
            expect(input.record.ownerId).toBeNull();
            expect(input.record.organization).toEqual({
              tags: [],
              collections: [],
            });
            await expect(
              ctx.organization.ensureTag({ name: "Guest tag" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            return { status: "pass" };
          },
        },
      ],
      [
        {
          async execute(input, ctx) {
            expect(input.record.ownerId).toBeNull();
            await expect(
              ctx.organization.ensureCollection({ name: "Guest album" }),
            ).rejects.toMatchObject({ code: "FORBIDDEN" });
            return { organization: { tagIds: [own.id] } };
          },
        },
      ],
    );
    const anonymous = await handler(f.app)(
      new Request("http://localhost/api/files", {
        method: "POST",
        body: form(f),
      }),
      "203.0.113.9",
    );
    expect(anonymous.status).toBe(201);
    const guestImage = (await anonymous.json()) as { id: string };
    await f.app.files.sweep();
    expect(await relations(f, guestImage.id)).toEqual({
      tags: [],
      collections: [],
    });
    const action = (await f.app.db.read((r) => r.tasks(guestImage.id))).find(
      (t) => t.kind === "action",
    )!;
    expect(action.status).toBe("failed");
    expect(action.last_error).toContain("PROCESSING_RESULT_INVALID");
    const batch = await f.request("/api/files/batch-tags", "POST", {
      ids: [guestImage.id],
      add: [own.id],
    });
    expect((await batch.json()).results).toEqual([
      { id: guestImage.id, accepted: false, error: "FORBIDDEN" },
    ]);
  } finally {
    await f.close();
  }
});

test("chunks retain initial IDs, resolve current names and skip selected targets deleted before completion", async () => {
  const f = await fixture();
  try {
    const tag = await create(f, "tags", { name: "Before" });
    const uploaded = await chunk(f, { tagIds: [tag.id] });
    expect(
      (await f.app.db.read((r) => r.uploadSession(uploaded.id)))
        ?.organization_json,
    ).toEqual({ tagIds: [tag.id], collectionIds: [] });
    expect(
      (await f.request(`/api/tags/${tag.id}`, "PATCH", { name: "Renamed" }))
        .status,
    ).toBe(200);
    let observedName = "";
    await configure(f, [
      {
        check: applicable,
        async process(input) {
          observedName = input.record.organization.tags[0]!.name;
          return { status: "pass" };
        },
      },
    ]);
    const completed = await f.request(
      `/api/uploads/${uploaded.id}/complete`,
      "POST",
    );
    expect(completed.status).toBe(200);
    const image = (await completed.json()) as { id: string };
    expect(observedName).toBe("Renamed");
    expect((await relations(f, image.id)).tags.map((x) => x.id)).toEqual([
      tag.id,
    ]);
    const pending = await chunk(f, { tagIds: [tag.id] });
    await configure(f);
    expect((await f.request(`/api/tags/${tag.id}`, "DELETE")).status).toBe(200);
    const response = await f.request(
      `/api/uploads/${pending.id}/complete`,
      "POST",
    );
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect((await relations(f, saved.id)).tags).toEqual([]);
    expect(await f.app.db.read((r) => r.countFiles())).toBe(2);
  } finally {
    await f.close();
  }
});

test("replacement inherits the old owner's relations and preserves the new upload origin", async () => {
  const f = await fixture();
  try {
    const userResponse = await f.request("/api/users", "POST", {
      username: "member",
      password: "member-password",
      role: "member",
      profileIds: [f.profileId],
    });
    expect(userResponse.status).toBe(201);
    const member = (await userResponse.json()) as { id: string };
    const tag = await create(f, "tags", { name: "Keep", ownerId: member.id }),
      collection = await create(f, "collections", {
        name: "Keep album",
        ownerId: member.id,
      });
    const login = await f.app.auth.login(
      "member",
      "member-password",
      "organization-test",
    );
    const oldResponse = await handler(f.app)(
      new Request("http://localhost/api/files", {
        method: "POST",
        headers: {
          cookie: f.app.auth.cookie(login.secret),
          "x-csrf-token": f.app.auth.csrf(hash(login.secret)),
        },
        body: form(f, { tagIds: [tag.id], collectionIds: [collection.id] }),
      }),
    );
    expect(oldResponse.status).toBe(201);
    const old = (await oldResponse.json()) as { id: string; url: string };
    const discarded = await create(f, "tags", { name: "Discard" });
    const newResponse = await f.request(
      "/api/files",
      "POST",
      form(f, { tagIds: [discarded.id] }),
    );
    expect(newResponse.status).toBe(201);
    const next = (await newResponse.json()) as { id: string; url: string };
    await f.app.files.sweep();
    const originalNext = (await f.app.db.read((r) => r.file(next.id)))!;
    const replaced = await f.request(`/api/files/${old.id}/replace`, "POST", {
      replacementId: next.id,
      replacementPath: new URL(next.url).pathname,
    });
    expect(replaced.status).toBe(200);
    const changed = (await f.app.db.read((r) => r.file(next.id)))!;
    expect(changed.owner_id).toBe(member.id);
    expect(changed.origin_user_id).toBe(originalNext.origin_user_id);
    expect(changed.origin_kind).toBe("upload");
    expect(changed.origin_user_id).not.toBe(member.id);
    const detail = await (await f.request(`/api/files/${next.id}`)).json();
    expect(detail.ownerName).toBe("member");
    expect(detail.origin.userName).toBe(
      (await f.app.db.read((r) => r.user(originalNext.origin_user_id!)))!
        .username,
    );
    expect((await relations(f, next.id)).tags.map((x) => x.id)).toEqual([
      tag.id,
    ]);
    expect((await relations(f, next.id)).collections.map((x) => x.id)).toEqual([
      collection.id,
    ]);
    expect(await relations(f, old.id)).toEqual({ tags: [], collections: [] });
    expect(((await replaced.json()) as { url: string }).url).toBe(old.url);
  } finally {
    await f.close();
  }
});
