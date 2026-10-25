import { organizationRequest } from "../src/http/organization";
import { describe, test, expect } from "bun:test";
import {
  Organization,
  parseOrganizationSelection,
  parseOrganizationUpdate,
} from "../src/core/organization";
import {
  entity,
  type Persistence,
  type User,
  type FileRecord,
} from "../src/persistence/port";
import type { Identity } from "../src/core/auth";
import { normalizeOrganizationName } from "../shared/organization";

export function organizationContract(
  name: string,
  open: () => Promise<{ db: Persistence; close(): Promise<void> }>,
) {
  describe(`${name}: organization`, () => {
    test("management routes paginate, reject transferred ownership, and keep explicit-field updates and replacement origin", async () => {
      const context = await open();
      try {
        const { db } = context,
          organization = new Organization(db),
          user = await addUser(db),
          actor = identity(user);
        const app = { organization };
        const created = await organizationRequest(
          app,
          actor,
          "/api/tags",
          "POST",
          async () => ({ name: "alpha" }),
        );
        expect(created?.status).toBe(201);
        const tag = (await created!.json()) as { id: string };
        const listed = await organizationRequest(
          app,
          actor,
          "/api/tags",
          "GET",
          async () => ({}),
          new URLSearchParams("q=alp&limit=1"),
        );
        expect(listed?.headers.get("x-total-count")).toBe("1");
        expect(((await listed!.json()) as { id: string }[])[0]?.id).toBe(
          tag.id,
        );
        await expect(
          organizationRequest(
            app,
            actor,
            `/api/tags/${tag.id}`,
            "PATCH",
            async () => ({ ownerId: null }),
          ),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(
          organizationRequest(
            app,
            actor,
            "/api/tags",
            "GET",
            async () => ({}),
            new URLSearchParams("limit="),
          ),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(
          organization.listTags(actor, user.id, { order: "desc" }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        const collection = await organization.createCollection(actor, {
          name: "album",
        });
        const old = await addFile(db, user.id, 1),
          replacement = await addFile(db, user.id, 2);
        await db.transaction((r) =>
          organization.write(r, old.id, user.id, {
            tagIds: [tag.id],
            collectionIds: [collection.id],
          }),
        );
        const current = await db.read((r) => organization.read(r, old.id));
        expect(
          (await organization.applyUpdate(user.id, current, undefined))
            .organization,
        ).toEqual(current);
        // Updating one field leaves the other field's current database values alone.
        await db.transaction((r) =>
          organization.write(r, old.id, user.id, { tagIds: [] }),
        );
        expect(
          (await db.read((r) => organization.read(r, old.id))).collections,
        ).toHaveLength(1);
        await db.transaction((r) =>
          organization.transfer(r, old.id, replacement.id),
        );
        expect(
          (await db.read((r) => organization.read(r, old.id))).collections,
        ).toEqual([]);
        expect(
          (
            await db.read((r) => organization.read(r, replacement.id))
          ).collections.map((x) => x.id),
        ).toEqual([collection.id]);
        expect(
          (await db.read((r) => r.file(replacement.id)))?.origin_user_id,
        ).toBe(replacement.origin_user_id);
        await expect(
          db.transaction((r) => r.replaceFileTags(replacement.id, ["missing"])),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(
          (await db.read((r) => organization.read(r, replacement.id))).tags,
        ).toEqual([]);
      } finally {
        await context.close();
      }
    });
    test("normalizes names, isolates registered owners, rejects guest organization, and preserves ensure definitions", async () => {
      const context = await open();
      try {
        const { db } = context,
          organization = new Organization(db);
        const user = await addUser(db),
          other = await addUser(db),
          actor = identity(user, "owner");
        const first = await organization.createTag(actor, {
          name: "  E\u0301té  ",
        });
        expect(first.name).toBe("Été");
        await expect(
          organization.createTag(actor, { name: "ÉTÉ" }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          organization.createTag(actor, { name: "été", ownerId: null }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(
          organization.createCollection(actor, {
            name: "album",
            ownerId: null,
          }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await expect(
          db.transaction((r) =>
            r.insertTag({
              ...entity(),
              name: "guest",
              name_key: "guest",
              // @ts-expect-error Registered ownership is also enforced by both databases.
              owner_id: null,
            }),
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          db.transaction((r) =>
            r.insertCollection({
              ...entity(),
              name: "guest",
              name_key: "guest",
              description: "",
              // @ts-expect-error Registered ownership is also enforced by both databases.
              owner_id: null,
            }),
          ),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        const guestCatalog = organization.scope(null);
        for (const call of [
          () => guestCatalog.reader.listTags(),
          () => guestCatalog.reader.listCollections(),
          () => guestCatalog.writer.ensureTag({ name: "guest" }),
          () => guestCatalog.writer.ensureCollection({ name: "guest" }),
        ])
          await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(
          organization.resolve(null, { tagIds: [first.id] }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        await organization.createTag(actor, { name: "été", ownerId: other.id });
        const collection = await organization.createCollection(actor, {
          name: "same",
          description: "keep",
        });
        const ensured = await organization
          .scope(user.id)
          .writer.ensureCollection({ name: "SAME" });
        expect(ensured.id).toBe(collection.id);
        expect(
          (await organization.getCollection(actor, collection.id)).description,
        ).toBe("keep");
        await expect(
          organization.createTag(identity(other), {
            name: "bad",
            ownerId: user.id,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(normalizeOrganizationName("\u0000", "tag")).toBeNull();
        expect(
          normalizeOrganizationName("😀".repeat(64), "tag"),
        ).not.toBeNull();
        expect(normalizeOrganizationName("😀".repeat(65), "tag")).toBeNull();
        expect(parseOrganizationSelection(undefined)).toEqual({
          tagIds: [],
          collectionIds: [],
        });
        expect(parseOrganizationUpdate({ tagIds: ["b", "a", "a"] })).toEqual({
          tagIds: ["a", "b"],
        });
      } finally {
        await context.close();
      }
    });
    test("same-owner transactions, relation filters, previews and definition deletion preserve files", async () => {
      const context = await open();
      try {
        const { db } = context,
          organization = new Organization(db),
          user = await addUser(db),
          other = await addUser(db),
          actor = identity(user, "owner");
        const a = await organization.createTag(actor, { name: "a" }),
          b = await organization.createTag(actor, { name: "b" });
        const foreign = await organization.createTag(actor, {
          name: "foreign",
          ownerId: other.id,
        });
        const collection = await organization.createCollection(actor, {
          name: "album",
        });
        const first = await addFile(db, user.id, 10),
          second = await addFile(db, user.id, 20),
          third = await addFile(db, user.id, 30, "blocked");
        await db.transaction((r) =>
          organization.write(r, first.id, user.id, {
            tagIds: [a.id, b.id],
            collectionIds: [collection.id],
          }),
        );
        await db.transaction((r) =>
          organization.write(r, second.id, user.id, {
            tagIds: [a.id],
            collectionIds: [collection.id],
          }),
        );
        await db.transaction((r) =>
          organization.write(r, third.id, user.id, {
            collectionIds: [collection.id],
          }),
        );
        await expect(
          db.transaction((r) =>
            organization.write(r, first.id, user.id, { tagIds: [foreign.id] }),
          ),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(
          (await organization.resolve(user.id, { tagIds: [a.id] })).tags,
        ).toEqual([{ id: a.id, name: "a" }]);
        const all = await db.read((r) =>
          r.files(10, 0, { tagIds: [a.id, b.id], tagMode: "all" }),
        );
        expect(all.map((x) => x.id)).toEqual([first.id]);
        const any = await db.read((r) =>
          r.files(1, 1, { tagIds: [a.id, b.id], tagMode: "any", order: "asc" }),
        );
        expect(any.map((x) => x.id)).toEqual([second.id]);
        expect(
          await db.read((r) =>
            r.countFiles({ tagIds: [a.id, b.id], tagMode: "any" }),
          ),
        ).toBe(2);
        expect(
          await db.read((r) =>
            r.countFiles({ untagged: true, collectionId: collection.id }),
          ),
        ).toBe(1);
        const detail = await organization.getCollection(actor, collection.id);
        expect(detail.readyFileCount).toBe(2);
        expect(detail.preview?.fileId).toBe(second.id);
        await expect(
          organization.fileFilter(actor, { tagIds: [a.id], ownerId: other.id }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await organization.delete(actor, "tag", a.id);
        await organization.delete(actor, "collection", collection.id);
        expect(
          (await db.read((r) => organization.read(r, first.id))).tags.map(
            (x) => x.id,
          ),
        ).toEqual([b.id]);
        expect(
          (await db.read((r) => organization.read(r, first.id))).collections,
        ).toEqual([]);
        expect((await db.read((r) => r.file(first.id)))?.status).toBe("ready");
      } finally {
        await context.close();
      }
    });
    test("batch final limits are atomic, deletion permits removal, and plugin commit ignores deleted targets only", async () => {
      const context = await open();
      try {
        const { db } = context,
          organization = new Organization(db),
          user = await addUser(db),
          actor = identity(user, "owner");
        const tags = await db.transaction(async (r) => {
          const tags = Array.from({ length: 101 }, (_, i) => ({
            ...entity(),
            owner_id: user.id,
            name: `tag${i}`,
            name_key: `tag${i}`,
          }));
          for (const tag of tags) await r.insertTag(tag);
          return tags;
        });
        const file = await addFile(db, user.id, 1);
        await db.transaction((r) =>
          organization.write(r, file.id, user.id, {
            tagIds: tags.slice(0, 100).map((x) => x.id),
          }),
        );
        const rejected = await organization.batch(actor, "tag", {
          ids: [file.id],
          add: [tags[100]!.id],
        });
        expect(rejected.results[0]).toMatchObject({
          accepted: false,
          error: "INVALID_INPUT",
        });
        expect(
          (await db.read((r) => organization.read(r, file.id))).tags,
        ).toHaveLength(100);
        expect(
          (
            await organization.batch(actor, "tag", {
              ids: [file.id],
              add: [tags[100]!.id],
              remove: [tags[0]!.id],
            })
          ).results[0]?.accepted,
        ).toBe(true);
        await organization.delete(actor, "tag", tags[100]!.id);
        await db.transaction((r) =>
          organization.write(
            r,
            file.id,
            user.id,
            { tagIds: [tags[100]!.id] },
            { ignoreMissing: true },
          ),
        );
        expect(
          (await db.read((r) => organization.read(r, file.id))).tags,
        ).toHaveLength(0);
        const deleted = await addFile(db, user.id, 2, "deleted");
        expect(
          (
            await organization.batch(actor, "tag", {
              ids: [deleted.id],
              add: [tags[0]!.id],
            })
          ).results[0]?.accepted,
        ).toBe(false);
        await db.transaction((r) =>
          r.replaceFileTags(deleted.id, [tags[0]!.id]),
        );
        expect(
          (
            await organization.batch(actor, "tag", {
              ids: [deleted.id],
              remove: [tags[0]!.id],
            })
          ).results[0]?.accepted,
        ).toBe(true);
        let active = true;
        const service = organization.scope(
          user.id,
          undefined,
          () => active,
        ).writer;
        active = false;
        await expect(service.ensureTag({ name: "late" })).rejects.toMatchObject(
          { code: "SCOPE_CLOSED" },
        );
      } finally {
        await context.close();
      }
    });
  });
}
async function addUser(db: Persistence): Promise<User> {
  const user: User = {
    ...entity(),
    username: crypto.randomUUID(),
    password_hash: "unused",
    role: "member",
    status: "active",
    auth_version: 1,
    max_upload_bytes: null,
    daily_upload_limit: null,
    default_upload_profile_id: null,
  };
  await db.transaction((r) => r.insertUser(user));
  return user;
}
function identity(user: User, role: User["role"] = "member"): Identity {
  return {
    user: { ...user, role },
    kind: "session",
    hash: "unused",
    credential: {
      ...entity(),
      user_id: user.id,
      token_hash: "unused",
      expires_at: null,
      revoked_at: null,
    },
  };
}
async function addFile(
  db: Persistence,
  ownerId: string | null,
  created: number,
  status: FileRecord["status"] = "ready",
) {
  const base = entity(),
    file: FileRecord = {
      ...base,
      created_at: created,
      owner_id: ownerId,
      origin_kind: "upload",
      origin_user_id: ownerId,
      guest_ip: null,
      upload_profile_id: null,
      storage_group_id: null,
      public_prefix: "/i/",
      logical_key: base.id,
      storage_key: base.id,
      mime_type: "image/png",
      byte_size: 1,
      width: 1,
      height: 1,
      status,
      temp_path: null,
      temp_status: "cleaned",
      last_error: null,
      processing_results_json: null,
    };
  await db.transaction((r) => r.insertFile(file));
  return file;
}
