import { isSiteAdmin } from "../../shared/roles";
import {
  normalizeOrganizationName,
  validOrganizationDescription,
  ORGANIZATION_LIMIT,
  type OrganizationUpdate,
  type OrganizationSelection,
  type FileOrganization,
  type OrganizationQuery,
  type TagView,
  type CollectionView,
} from "../../shared/organization";
import {
  entity,
  type Persistence,
  type Repositories,
  type Tag,
  type Collection,
  type FileFilter,
} from "../persistence/port";
import type { Identity } from "./auth";
import { AppError, Conflict, requireValue } from "./errors";

const invalid = (message = "Invalid organization") =>
  new AppError("INVALID_INPUT", message);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
export function parseOrganizationUpdate(value: unknown): OrganizationUpdate {
  const input = object(value);
  if (
    Object.keys(input).some(
      (key) => key !== "tagIds" && key !== "collectionIds",
    )
  )
    throw invalid();
  const result: { tagIds?: string[]; collectionIds?: string[] } = {};
  for (const key of ["tagIds", "collectionIds"] as const) {
    if (!(key in input)) continue;
    const items = input[key];
    if (
      !Array.isArray(items) ||
      items.some((id) => typeof id !== "string" || !id)
    )
      throw invalid();
    const ids = [...new Set(items as string[])].sort();
    if (ids.length > ORGANIZATION_LIMIT)
      throw invalid("At most 100 tags and collections per file");
    result[key] = ids;
  }
  return result;
}
export function parseOrganizationSelection(
  value: unknown,
): OrganizationSelection {
  const update = value === undefined ? {} : parseOrganizationUpdate(value);
  return {
    tagIds: [...(update.tagIds ?? [])],
    collectionIds: [...(update.collectionIds ?? [])],
  };
}
export function organizationSelection(
  value: FileOrganization,
): OrganizationSelection {
  return {
    tagIds: value.tags.map((x) => x.id),
    collectionIds: value.collections.map((x) => x.id),
  };
}
export function organizationQuery(
  value: OrganizationQuery = {},
): OrganizationQuery {
  const { limit = 50, offset = 0 } = value;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (value.q !== undefined && typeof value.q !== "string") ||
    (value.sort !== undefined && !["name", "createdAt"].includes(value.sort)) ||
    (value.order !== undefined && !["asc", "desc"].includes(value.order))
  )
    throw invalid("Invalid pagination or sorting");
  return { ...value, limit, offset };
}
const item = (value: Tag) => ({ id: value.id, name: value.name });
const view = (value: Tag): TagView => ({
  id: value.id,
  ownerId: value.owner_id,
  name: value.name,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
});
const assertOwner = (actor: Identity, ownerId: string | null) => {
  if (
    ownerId === null ||
    actor.kind !== "session" ||
    (!isSiteAdmin(actor.user.role) && actor.user.id !== ownerId)
  )
    throw new AppError("FORBIDDEN", "Organization scope is not permitted", 403);
};
function normalizedName(value: unknown, kind: "tag" | "collection") {
  const result = normalizeOrganizationName(value, kind);
  if (!result) throw invalid("Invalid name");
  return { name: result.name, name_key: result.nameKey };
}
function description(value: unknown) {
  if (!validOrganizationDescription(value))
    throw invalid("Invalid collection description");
  return value;
}
export class Organization {
  constructor(private db: Persistence) {}
  async owner(actor: Identity, requested?: string) {
    const ownerId = requested === undefined ? actor.user.id : requested;
    assertOwner(actor, ownerId);
    await this.db.read(async (r) =>
      requireValue(await r.user(ownerId), "User not found"),
    );
    return ownerId;
  }
  async read(r: Repositories, fileId: string): Promise<FileOrganization> {
    const tags = await r.fileTags([fileId]),
      collections = await r.fileCollections([fileId]);
    return {
      tags: (tags.get(fileId) ?? []).map(item),
      collections: (collections.get(fileId) ?? []).map(item),
    };
  }
  async snapshot(
    r: Repositories,
    ownerId: string | null,
    value: unknown,
  ): Promise<FileOrganization> {
    const selection = parseOrganizationSelection(value);
    if (
      ownerId === null &&
      (selection.tagIds.length || selection.collectionIds.length)
    )
      throw new AppError(
        "FORBIDDEN",
        "Guest images cannot have organization",
        403,
      );
    const tags: Tag[] = [],
      collections: Collection[] = [];
    for (const id of selection.tagIds) {
      const tag = await r.tag(id);
      if (!tag || tag.owner_id !== ownerId)
        throw invalid("Tag does not exist in this owner scope");
      tags.push(tag);
    }
    for (const id of selection.collectionIds) {
      const collection = await r.collection(id);
      if (!collection || collection.owner_id !== ownerId)
        throw invalid("Collection does not exist in this owner scope");
      collections.push(collection);
    }
    return { tags: tags.map(item), collections: collections.map(item) };
  }
  resolve(ownerId: string | null, value?: unknown) {
    return this.db.read((r) => this.snapshot(r, ownerId, value));
  }
  async applyUpdate(
    ownerId: string | null,
    current: FileOrganization,
    value: unknown,
  ) {
    const update = value === undefined ? {} : parseOrganizationUpdate(value);
    const resolved = await this.resolve(ownerId, update);
    return {
      organization: {
        tags:
          update.tagIds === undefined
            ? current.tags.map((x) => ({ ...x }))
            : resolved.tags,
        collections:
          update.collectionIds === undefined
            ? current.collections.map((x) => ({ ...x }))
            : resolved.collections,
      },
      update,
    };
  }
  /** Call inside the same transaction that creates/updates the file. */
  async write(
    r: Repositories,
    fileId: string,
    ownerId: string | null,
    value: unknown,
    options: { ignoreMissing?: boolean } = {},
  ) {
    const update = parseOrganizationUpdate(value);
    if (
      ownerId === null &&
      (update.tagIds?.length || update.collectionIds?.length)
    )
      throw new AppError(
        "FORBIDDEN",
        "Guest images cannot have organization",
        403,
      );
    const file = requireValue(await r.file(fileId));
    if (file.owner_id !== ownerId) throw invalid("File owner changed");
    const selection: { tagIds?: string[]; collectionIds?: string[] } = {};
    for (const key of ["tagIds", "collectionIds"] as const) {
      if (update[key] === undefined) continue;
      const ids: string[] = [];
      for (const id of update[key]!) {
        const target =
          key === "tagIds" ? await r.tag(id) : await r.collection(id);
        if (!target && options.ignoreMissing) continue;
        if (!target || target.owner_id !== ownerId)
          throw invalid(
            "Organization target does not exist in this owner scope",
          );
        ids.push(id);
      }
      selection[key] = ids;
    }
    if (selection.tagIds !== undefined)
      await r.replaceFileTags(fileId, selection.tagIds);
    if (selection.collectionIds !== undefined)
      await r.replaceFileCollections(fileId, selection.collectionIds);
  }
  async transfer(r: Repositories, fromId: string, toId: string) {
    const source = requireValue(await r.file(fromId)),
      target = requireValue(await r.file(toId));
    if (source.owner_id !== target.owner_id)
      throw invalid("Replacement owner must match");
    const value = organizationSelection(await this.read(r, fromId));
    await this.write(r, toId, target.owner_id, value);
    await r.replaceFileTags(fromId, []);
    await r.replaceFileCollections(fromId, []);
  }
  async listTags(
    actor: Identity,
    ownerId: string,
    query: OrganizationQuery = {},
  ) {
    assertOwner(actor, ownerId);
    if (query.sort !== undefined || query.order !== undefined)
      throw invalid("Tags have a fixed name order");
    query = organizationQuery(query);
    return this.db.read(async (r) => ({
      items: (await r.tags(ownerId, query)).map(view),
      total: await r.countTags(ownerId, query.q),
    }));
  }
  private async collectionViews(
    r: Repositories,
    values: Collection[],
  ): Promise<CollectionView[]> {
    const summary = await r.collectionSummaries(values.map((x) => x.id));
    return values.map((value) => {
      const stats = summary.get(value.id);
      return {
        ...view(value),
        description: value.description,
        readyFileCount: stats?.ready_file_count ?? 0,
        preview: stats?.preview_file_id
          ? {
              fileId: stats.preview_file_id,
              thumbnailUrl: `/api/files/${encodeURIComponent(stats.preview_file_id)}/thumbnail`,
            }
          : null,
      };
    });
  }
  async listCollections(
    actor: Identity,
    ownerId: string,
    query: OrganizationQuery = {},
  ) {
    assertOwner(actor, ownerId);
    query = organizationQuery(query);
    return this.db.read(async (r) => ({
      items: await this.collectionViews(r, await r.collections(ownerId, query)),
      total: await r.countCollections(ownerId, query.q),
    }));
  }
  async getCollection(actor: Identity, id: string) {
    return this.db.read(async (r) => {
      const value = requireValue(await r.collection(id));
      assertOwner(actor, value.owner_id);
      return (await this.collectionViews(r, [value]))[0]!;
    });
  }
  async createTag(actor: Identity, input: Record<string, unknown>) {
    if (Object.keys(input).some((k) => !["name", "ownerId"].includes(k)))
      throw invalid();
    if (input.ownerId !== undefined && typeof input.ownerId !== "string")
      throw invalid();
    const ownerId = await this.owner(
      actor,
      input.ownerId as string | undefined,
    );
    const value: Tag = {
      ...entity(),
      owner_id: ownerId,
      ...normalizedName(input.name, "tag"),
    };
    await this.db.transaction((r) => r.insertTag(value));
    return view(value);
  }
  async createCollection(actor: Identity, input: Record<string, unknown>) {
    if (
      Object.keys(input).some(
        (k) => !["name", "description", "ownerId"].includes(k),
      )
    )
      throw invalid();
    if (input.ownerId !== undefined && typeof input.ownerId !== "string")
      throw invalid();
    const ownerId = await this.owner(
      actor,
      input.ownerId as string | undefined,
    );
    const value: Collection = {
      ...entity(),
      owner_id: ownerId,
      ...normalizedName(input.name, "collection"),
      description:
        input.description === undefined ? "" : description(input.description),
    };
    return this.db.transaction(async (r) => {
      await r.insertCollection(value);
      return (await this.collectionViews(r, [value]))[0]!;
    });
  }
  async updateTag(actor: Identity, id: string, input: Record<string, unknown>) {
    if (Object.keys(input).some((k) => k !== "name") || !("name" in input))
      throw invalid();
    return this.db.transaction(async (r) => {
      const value = requireValue(await r.tag(id));
      assertOwner(actor, value.owner_id);
      Object.assign(value, normalizedName(input.name, "tag"), {
        updated_at: Date.now(),
      });
      await r.saveTag(value);
      return view(value);
    });
  }
  async updateCollection(
    actor: Identity,
    id: string,
    input: Record<string, unknown>,
  ) {
    if (
      !Object.keys(input).length ||
      Object.keys(input).some((k) => !["name", "description"].includes(k))
    )
      throw invalid();
    return this.db.transaction(async (r) => {
      const value = requireValue(await r.collection(id));
      assertOwner(actor, value.owner_id);
      if ("name" in input)
        Object.assign(value, normalizedName(input.name, "collection"));
      if ("description" in input)
        value.description = description(input.description);
      value.updated_at = Date.now();
      await r.saveCollection(value);
      return (await this.collectionViews(r, [value]))[0]!;
    });
  }
  async delete(actor: Identity, kind: "tag" | "collection", id: string) {
    await this.db.transaction(async (r) => {
      const value = requireValue(
        kind === "tag" ? await r.tag(id) : await r.collection(id),
      );
      assertOwner(actor, value.owner_id);
      if (kind === "tag") await r.deleteTag(id);
      else await r.deleteCollection(id);
    });
  }
  async batch(
    actor: Identity,
    kind: "tag" | "collection",
    input: Record<string, unknown>,
  ) {
    if (Object.keys(input).some((k) => !["ids", "add", "remove"].includes(k)))
      throw invalid();
    const { ids, add = [], remove = [] } = input;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      throw invalid("Invalid file IDs");
    const field = kind === "tag" ? "tagIds" : "collectionIds";
    const adding = parseOrganizationUpdate({ [field]: add })[field]!,
      removing = parseOrganizationUpdate({ [field]: remove })[field]!;
    if (
      (!adding.length && !removing.length) ||
      adding.some((id) => removing.includes(id))
    )
      throw invalid("Invalid relationship changes");
    // Validate the targets once before reporting per-file outcomes.
    const ownerId = await this.db.read(async (r) => {
      let owner: string | undefined;
      for (const id of [...adding, ...removing]) {
        const value = requireValue(
          kind === "tag" ? await r.tag(id) : await r.collection(id),
        );
        assertOwner(actor, value.owner_id);
        if (owner !== undefined && value.owner_id !== owner)
          throw invalid("Targets must share one owner");
        owner = value.owner_id;
      }
      return owner!;
    });
    const results = [];
    for (const id of ids as string[]) {
      try {
        await this.db.transaction(async (r) => {
          const file = requireValue(await r.file(id));
          assertOwner(actor, file.owner_id);
          if (file.owner_id !== ownerId)
            throw invalid("File and targets must share one owner");
          if (
            adding.length &&
            ["deleting", "delete_failed", "deleted"].includes(file.status)
          )
            throw new AppError("FILE_NOT_EDITABLE", "File is being deleted");
          // Revalidate both additions and removals, including targets deleted after prevalidation.
          await this.snapshot(r, ownerId, { [field]: adding });
          await this.snapshot(r, ownerId, { [field]: removing });
          const current = await this.read(r, id),
            present = kind === "tag" ? current.tags : current.collections;
          const next = [
            ...new Set([
              ...present
                .filter((x) => !removing.includes(x.id))
                .map((x) => x.id),
              ...adding,
            ]),
          ].sort();
          await this.write(r, id, ownerId, { [field]: next });
        });
        results.push({ id, accepted: true });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        results.push({ id, accepted: false, error: error.code });
      }
    }
    return { results };
  }
  async fileFilter(actor: Identity, filter: FileFilter): Promise<FileFilter> {
    if (
      (filter.untagged && filter.tagIds?.length) ||
      (filter.uncollected && filter.collectionId)
    )
      throw invalid("Conflicting organization filters");
    if (
      filter.tagMode !== undefined &&
      !["all", "any"].includes(filter.tagMode)
    )
      throw invalid();
    return this.db.read(async (r) => {
      const targets = [
        ...(await Promise.all((filter.tagIds ?? []).map((id) => r.tag(id)))),
        ...(filter.collectionId
          ? [await r.collection(filter.collectionId)]
          : []),
      ];
      let ownerId = filter.ownerId;
      for (const target of targets) {
        if (!target) throw invalid("Organization filter not found");
        assertOwner(actor, target.owner_id);
        if (ownerId !== undefined && ownerId !== target.owner_id)
          throw invalid("Conflicting owner filters");
        ownerId = target.owner_id;
      }
      return { ...filter, ...(ownerId !== undefined ? { ownerId } : {}) };
    });
  }
  scope(
    ownerId: string | null,
    signal?: AbortSignal,
    isActive: () => boolean = () => true,
  ) {
    const check = () => {
      if (ownerId === null)
        throw new AppError(
          "FORBIDDEN",
          "Organization requires a registered owner",
          403,
        );
      if (signal?.aborted)
        throw signal.reason ?? new AppError("ABORTED", "Operation aborted");
      if (!isActive())
        throw new AppError(
          "SCOPE_CLOSED",
          "Organization service call has ended",
        );
      return ownerId;
    };
    const reader = {
      listTags: async (query?: OrganizationQuery) => {
        const userId = check();
        const q = organizationQuery(query);
        const result = await this.db.read(async (r) => ({
          items: (await r.tags(userId, q)).map(item),
          total: await r.countTags(userId, q.q),
        }));
        check();
        return result;
      },
      listCollections: async (query?: OrganizationQuery) => {
        const userId = check();
        const q = organizationQuery(query);
        const result = await this.db.read(async (r) => ({
          items: (await r.collections(userId, q)).map(item),
          total: await r.countCollections(userId, q.q),
        }));
        check();
        return result;
      },
    };
    const ensure = async (
      kind: "tag" | "collection",
      input: { name: string },
    ) => {
      const userId = check();
      const normalized = normalizedName(input.name, kind);
      const find = (r: Repositories) =>
        kind === "tag"
          ? r.tagByName(userId, normalized.name_key)
          : r.collectionByName(userId, normalized.name_key);
      try {
        const result = await this.db.transaction(async (r) => {
          check();
          const existing = await find(r);
          if (existing) return item(existing);
          const value = { ...entity(), owner_id: userId, ...normalized };
          if (kind === "tag") await r.insertTag(value);
          else await r.insertCollection({ ...value, description: "" });
          check();
          return item(value);
        });
        check();
        return result;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        check();
        const existing = await this.db.read(find);
        check();
        if (!existing) throw error;
        return item(existing);
      }
    };
    return {
      reader,
      writer: {
        ...reader,
        ensureTag: (input: { name: string }) => ensure("tag", input),
        ensureCollection: (input: { name: string }) =>
          ensure("collection", input),
      },
    };
  }
}
