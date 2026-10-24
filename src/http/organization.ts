import type { Organization } from "../core/organization";
import type { Identity } from "../core/auth";
import { AppError } from "../core/errors";
import type { OrganizationQuery } from "../../shared/organization";
const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
/** The caller authenticates a session and checks CSRF before dispatch. */
export async function organizationRequest(
  app: { organization: Organization },
  auth: Identity,
  path: string,
  method: string,
  body: () => Promise<Record<string, unknown>>,
  query = new URLSearchParams(),
): Promise<Response | null> {
  const route = path.match(/^\/api\/(tags|collections)(?:\/([^/]+))?$/);
  if (route) {
    const kind = route[1] === "tags" ? "tag" : "collection",
      id = route[2] ? decodeURIComponent(route[2]) : undefined;
    if (!id && method === "GET") {
      const owner = query.get("owner"),
        ownerId = await app.organization.owner(auth, owner ?? undefined);
      const options: OrganizationQuery = {};
      for (const key of ["limit", "offset"] as const)
        if (query.has(key)) {
          const text = query.get(key)!;
          if (!/^\d+$/.test(text))
            throw new AppError("INVALID_INPUT", "Invalid pagination");
          options[key] = Number(text);
        }
      if (query.has("q")) options.q = query.get("q")!;
      if (query.has("sort"))
        options.sort = query.get("sort") as OrganizationQuery["sort"];
      if (query.has("order"))
        options.order = query.get("order") as OrganizationQuery["order"];
      const page =
        kind === "tag"
          ? await app.organization.listTags(auth, ownerId, options)
          : await app.organization.listCollections(auth, ownerId, options);
      return json(page.items, 200, { "X-Total-Count": String(page.total) });
    }
    if (!id && method === "POST")
      return json(
        kind === "tag"
          ? await app.organization.createTag(auth, await body())
          : await app.organization.createCollection(auth, await body()),
        201,
      );
    if (id && method === "GET" && kind === "collection")
      return json(await app.organization.getCollection(auth, id));
    if (id && method === "PATCH")
      return json(
        kind === "tag"
          ? await app.organization.updateTag(auth, id, await body())
          : await app.organization.updateCollection(auth, id, await body()),
      );
    if (id && method === "DELETE") {
      await app.organization.delete(auth, kind, id);
      return json({ ok: true });
    }
  }
  if (
    method === "POST" &&
    ["/api/files/batch-tags", "/api/files/batch-collections"].includes(path)
  )
    return json(
      await app.organization.batch(
        auth,
        path.endsWith("batch-tags") ? "tag" : "collection",
        await body(),
      ),
    );
  return null;
}
