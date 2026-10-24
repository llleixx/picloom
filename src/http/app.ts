import { organizationRequest } from "./organization";
import { themeRequest } from "./themes";
import { pluginErrorCode } from "../core/errors";
import { receiveMultipart } from "./multipart";
import { normalizeGuestIp } from "./guest-ip";
import { isPluginError } from "@picloom/plugin-sdk";
import { downloadImage } from "../infra/remote-image";
import { isWebRequest } from "../../shared/web-routes";
import { isSiteAdmin } from "../../shared/roles";
import { checkHotlink } from "./hotlink";
import type { Application } from "../bootstrap";
import { AppError, requireValue } from "../core/errors";
import { parseQuery, parseUploadParams } from "../core/request-params";
import type { FileRecord } from "../persistence/port";
import type { FileFilter } from "../persistence/port";
import type { FileView, ClientSettings } from "../../shared/api";
import { publicPath } from "../infra/files";
import { webPage } from "./static";
import { configurationRequest } from "./configuration";
import { PACKAGE_LIMIT } from "../plugins/archive";
const jsonResponse = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
function limitedBody(req: Request, limit: number) {
  if (Number(req.headers.get("content-length")) > limit)
    throw new AppError("TOO_LARGE", "Request too large", 413);
  let received = 0;
  return req.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > limit)
          throw new AppError("TOO_LARGE", "Request too large", 413);
        controller.enqueue(chunk);
      },
    }),
  );
}
async function body(req: Request) {
  const text = await new Response(limitedBody(req, 65536)).text();
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AppError("INVALID_INPUT", "Expected JSON object");
  }
}
const field = (obj: Record<string, unknown>, key: string) => {
  if (typeof obj[key] !== "string")
    throw new AppError("INVALID_INPUT", `Expected ${key}`);
  return obj[key] as string;
};
const view = (f: FileRecord, origin: string): FileView => ({
  id: f.id,
  ownerId: f.owner_id,
  tags: [],
  status: f.status,
  mimeType: f.mime_type,
  byteSize: f.byte_size,
  width: f.width,
  height: f.height,
  publicPrefix: f.public_prefix,
  logicalKey: f.logical_key,
  storageKey: f.storage_key,
  createdAt: f.created_at,
  deletedAt: f.deleted_at,
  error: f.last_error,
  url: origin + publicPath(f.public_prefix, f.logical_key),
});
export function handler(app: Application) {
  return async (req: Request, client = "127.0.0.1"): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const requestOrigin = new URL(req.url).origin;
    const json = (
      value: unknown,
      status = 200,
      headers: Record<string, string> = {},
    ) => {
      // Upload services can return a relative URL when no site origin is configured.
      if (
        value &&
        typeof value === "object" &&
        "url" in value &&
        typeof value.url === "string"
      )
        value = { ...value, url: new URL(value.url, requestOrigin).href };
      return jsonResponse(value, status, headers);
    };
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      if (path === "/favicon.ico") {
        if (!["GET", "HEAD"].includes(method))
          throw new AppError("METHOD", "Method not allowed", 405);
        const icon = app.delivery.get().siteFaviconUrl;
        const target = icon ? new URL(icon, url) : null;
        const self =
          target?.pathname === path &&
          [url.origin, app.config.origin, app.config.imageOrigin].includes(
            target.origin,
          );
        return new Response(null, {
          status: target && !self ? 302 : 404,
          headers: {
            "cache-control": "no-store",
            ...(target && !self ? { location: target.href } : {}),
          },
        });
      }
      const themeAsset = path.match(
        /^\/assets\/themes\/([^/]+)\/([^/]+)\/(.+)$/,
      );
      if (themeAsset)
        return await app.themes.resource(
          req,
          themeAsset[1]!,
          themeAsset[2]!,
          decodeURIComponent(themeAsset[3]!),
        );
      if (path === "/api/theme" && method === "GET")
        return json(app.themes.active());
      if (!app.webConflict && isWebRequest(path))
        return await webPage(req, app.config.webRoot);
      if (
        path.startsWith("/api/") &&
        app.config.origin &&
        req.headers.has("origin") &&
        req.headers.get("origin") !== app.config.origin
      )
        throw new AppError("ORIGIN", "Origin not allowed", 403);
      if (path === "/api/auth/login" && method === "POST") {
        const b = await body(req);
        const result = await app.auth.login(
          field(b, "username"),
          field(b, "password"),
          client,
        );
        return json(
          {
            user: {
              id: result.user.id,
              username: result.user.username,
              role: result.user.role,
            },
          },
          200,
          {
            "set-cookie": app.auth.cookie(result.secret, false, requestOrigin),
          },
        );
      }
      if (path.startsWith("/api/")) {
        if (path === "/api/files/from-url" && method === "POST") {
          const auth = await app.auth.optional(req);
          const guestIp = auth ? null : normalizeGuestIp(client);
          const input = await body(req);
          if (typeof input.url !== "string" || input.url.length > 8192)
            throw new AppError("INVALID_INPUT", "Expected url");
          const profileId = await app.auth.resolveUploadProfile(
            input.profileId,
            auth,
          );
          await app.files.validateUpload(profileId, 1, auth, guestIp);
          await app.files.uploadOrganization(
            app.auth.uploadOwner(auth).ownerId,
            input.organization,
          );
          const profile = (await app.files.uploadProfiles(auth)).find(
            (p) => p.id === profileId,
          );
          if (!profile)
            throw new AppError("FORBIDDEN", "Upload profile unavailable", 403);
          const leave = app.files.temporary.enterUpload();
          let inputPath: string | undefined;
          let handedOff = false;
          try {
            inputPath = app.files.temporary.create(profile.maxUploadBytes);
            const name = await downloadImage(
              input.url,
              profile.maxUploadBytes,
              req.signal,
              async (stream, name, signal) => {
                await app.files.temporary.write(
                  inputPath!,
                  stream,
                  profile.maxUploadBytes,
                  signal,
                );
                return name;
              },
            );
            const blob = Bun.file(inputPath);
            handedOff = true;
            return json(
              await app.files.upload(
                { size: blob.size, name, stream: () => blob.stream() },
                profileId,
                auth,
                req.signal,
                {},
                undefined,
                guestIp,
                inputPath,
                input.organization,
              ),
              201,
            );
          } finally {
            try {
              if (inputPath && !handedOff)
                await app.files.temporary.remove(inputPath);
            } finally {
              leave();
            }
          }
        }
        const upload = path === "/api/files" && method === "POST";
        const chunks = path.match(
          /^\/api\/uploads\/([a-f0-9-]{36})(?:\/(complete|parts\/(\d+)))?$/,
        );
        if (chunks) {
          const key = req.headers.get("x-upload-key") ?? "";
          if (!chunks[2] && method === "GET")
            return json(await app.uploads.progress(chunks[1]!, key));
          if (chunks[3] !== undefined && method === "PUT") {
            await app.uploads.part(chunks[1]!, Number(chunks[3]), req, key);
            return json({ ok: true });
          }
          if (chunks[2] === "complete" && method === "POST")
            return json(
              await app.uploads.complete(chunks[1]!, key, req.signal),
            );
          if (!chunks[2] && method === "DELETE") {
            await app.uploads.cancel(chunks[1]!, key);
            return json({ ok: true });
          }
          throw new AppError("METHOD", "Method not allowed", 405);
        }
        if (upload || (path === "/api/uploads" && method === "POST")) {
          const auth = await app.auth.optional(req);
          const guestIp = auth ? null : normalizeGuestIp(client);
          if (path === "/api/uploads")
            return json(
              await app.uploads.create(await body(req), auth, guestIp),
              201,
            );
          if (upload) {
            const limits = await app.auth.uploadLimits(auth);
            await app.auth.checkUploadQuota(auth, 0, guestIp);
            const leave = app.files.temporary.enterUpload();
            let inputPath: string | undefined;
            let handedOff = false;
            try {
              const received = await receiveMultipart(
                req,
                app.files.temporary,
                limits.maxBytes,
              );
              inputPath = received.path;
              const { fields } = received;
              const profile = fields.profileId;
              const blob = {
                name: received.name,
                size: received.size,
                stream: () => Bun.file(received.path).stream(),
              };
              let organization: unknown;
              const organizationField = fields.organization;
              if (organizationField !== undefined) {
                try {
                  organization = JSON.parse(organizationField);
                } catch {
                  throw new AppError(
                    "INVALID_INPUT",
                    "Expected JSON organization",
                  );
                }
              }
              const params = parseUploadParams(fields.params ?? null);
              const profileId = await app.auth.resolveUploadProfile(
                profile ?? undefined,
                auth,
              );
              await app.files.validateUpload(
                profileId,
                blob.size,
                auth,
                guestIp,
              );
              handedOff = true;
              return json(
                await app.files.upload(
                  blob,
                  profileId,
                  auth,
                  req.signal,
                  params,
                  undefined,
                  guestIp,
                  inputPath,
                  organization,
                ),
                201,
              );
            } finally {
              try {
                if (inputPath && !handedOff)
                  await app.files.temporary.remove(inputPath);
              } finally {
                leave();
              }
            }
          }
        }
        if (path === "/api/upload-defaults" && method === "GET")
          return json(
            await app.auth.uploadDefaults(await app.auth.optional(req)),
          );
        if (path === "/api/upload-profiles" && method === "GET")
          return json(
            await app.files.uploadProfiles(await app.auth.optional(req)),
          );
        if (path === "/api/client-settings" && method === "GET") {
          const site = app.delivery.get();
          const limits: ClientSettings = {
            enabledLocales: site.enabledLocales,
            defaultLocale: site.defaultLocale,
            content: site.content,
            siteLogoUrl: site.siteLogoUrl,
            siteFaviconUrl: site.siteFaviconUrl,
            uploadConcurrency: app.config.uploadConcurrency,
            chunkedUpload: {
              thresholdBytes: app.config.chunkThresholdBytes,
              partBytes: app.config.chunkPartBytes,
              concurrency: app.config.partConcurrency,
            },
            maxUploadBytes: app.config.maxUploadBytes,
            maxDimension: app.config.maxDimension,
            maxPixels: app.config.maxPixels,
          };
          return json(limits);
        }
        const auth = await app.auth.authenticate(req, true);
        if (
          path === "/api/theme" ||
          path === "/api/themes" ||
          path.startsWith("/api/themes/")
        ) {
          if (auth.user.role !== "owner")
            throw new AppError("FORBIDDEN", "Owner required", 403);
          return json(
            await themeRequest(app.themes, req, path, () => body(req)),
          );
        }
        if (path === "/api/access-parameters" && method === "GET")
          return json(await app.configuration.accessParameters());
        if (
          (path === "/api/auth/upload-default" ||
            path === "/api/site-upload-default") &&
          method === "PUT"
        ) {
          await app.auth.setDefaultProfile(
            auth,
            (await body(req)).profileId,
            path === "/api/site-upload-default",
          );
          return json(await app.auth.uploadDefaults(auth));
        }
        const organizationResponse = await organizationRequest(
          app,
          auth,
          path,
          method,
          () => body(req),
          url.searchParams,
        );
        if (organizationResponse) return organizationResponse;
        const workspaceRoute =
          path.startsWith("/api/auth/") ||
          path === "/api/tokens" ||
          path.startsWith("/api/tokens/") ||
          path === "/api/files" ||
          path === "/api/files/batch-delete" ||
          /^\/api\/files\/[^/]+(?:\/(?:thumbnail|replace))?$/.test(path);
        if (!workspaceRoute) app.auth.requireAdmin(auth);
        // Installing or reloading a package executes code with server privileges.
        // Keep package management separate from using already installed plugins.
        if (
          (path === "/api/plugin-packages" ||
            (path.startsWith("/api/plugins/") &&
              !["GET", "HEAD"].includes(method))) &&
          auth.user.role !== "owner"
        )
          throw new AppError("FORBIDDEN", "Owner required", 403);
        if (path === "/api/users" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 30),
            offset = Number(url.searchParams.get("offset") ?? 0);
          const q = (url.searchParams.get("q") ?? "").trim().toLowerCase(),
            status = url.searchParams.get("status") ?? "";
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            q.length > 64 ||
            !["", "active", "disabled"].includes(status)
          )
            throw new AppError("INVALID_INPUT", "Invalid user filter");
          return json(await app.auth.listUsers(limit, offset, q, status));
        }
        if (path === "/api/users" && method === "POST")
          return json(await app.auth.saveUser(auth, await body(req)), 201);
        const userRoute = path.match(/^\/api\/users\/([^/]+)(\/password)?$/);
        if (userRoute && !userRoute[2] && method === "PUT")
          return json(
            await app.auth.saveUser(auth, await body(req), userRoute[1]),
          );
        if (userRoute?.[2] && method === "POST") {
          await app.auth.resetPassword(
            auth,
            userRoute[1]!,
            field(await body(req), "password"),
          );
          return json({ ok: true });
        }
        if (path === "/api/plugins/inspect" && method === "POST") {
          const reader = req.body?.getReader();
          if (!reader)
            throw new AppError("PLUGIN_PACKAGE_INVALID", "请选择 ZIP 插件包");
          const parts: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > PACKAGE_LIMIT + 65536)
                throw new AppError("TOO_LARGE", "插件包不得超过 20 MB", 413);
              parts.push(value);
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
          }
          let form: FormData;
          try {
            form = await new Response(bytes, {
              headers: {
                "content-type": req.headers.get("content-type") ?? "",
              },
            }).formData();
          } catch {
            throw new AppError(
              "PLUGIN_PACKAGE_INVALID",
              "请使用 multipart 上传 ZIP 插件包",
            );
          }
          const file = form.get("file");
          if (!(file instanceof File))
            throw new AppError("PLUGIN_PACKAGE_INVALID", "请选择 ZIP 插件包");
          return json(
            await app.packages.inspect(
              new Uint8Array(await file.arrayBuffer()),
            ),
          );
        }
        const importRoute = path.match(
          /^\/api\/storage-sources\/([^/]+)\/import$/,
        );
        if (importRoute && method === "POST")
          return json(
            await app.imports.page(
              importRoute[1]!,
              await body(req),
              auth.user.id,
              { signal: req.signal, requestId, log() {} },
            ),
          );
        const configuration = isSiteAdmin(auth.user.role)
          ? await configurationRequest(
              app,
              path,
              method,
              () => body(req),
              url.searchParams,
            )
          : null;
        if (configuration) return configuration;
        if (path === "/api/system/status" && method === "GET")
          return json(await app.system.get());
        if (path === "/api/settings" && method === "GET")
          return json(app.delivery.get());
        if (path === "/api/settings" && method === "PUT")
          return json(await app.delivery.save(await body(req)));
        if (path === "/api/system/cache/clear" && method === "POST") {
          await app.files.cache.clear();
          await app.system.invalidateUsage();
          return json({ ok: true });
        }
        if (path === "/api/auth/session" && method === "GET")
          return json({
            user: {
              id: auth.user.id,
              username: auth.user.username,
              role: auth.user.role,
            },
            csrfToken: app.auth.csrf(auth.hash),
          });
        if (path === "/api/auth/logout" && method === "POST") {
          await app.db.transaction((r) =>
            r.revokeCredential("session", auth.credential.id, auth.user.id),
          );
          return json({ ok: true }, 200, {
            "set-cookie": app.auth.cookie("", true, requestOrigin),
          });
        }
        if (path === "/api/auth/password" && method === "POST") {
          const b = await body(req);
          await app.auth.password(
            auth,
            field(b, "oldPassword"),
            field(b, "password"),
          );
          return json({ ok: true }, 200, {
            "set-cookie": app.auth.cookie("", true, requestOrigin),
          });
        }
        if (path === "/api/tokens" && method === "POST") {
          const b = await body(req);
          return json(
            await app.auth.token(
              auth,
              field(b, "name"),
              b.expiresAt,
              b.profileIds,
            ),
            201,
          );
        }
        if (path === "/api/tokens" && method === "GET")
          return json(
            (await app.db.read((r) => r.tokens(auth.user.id))).map((t) => ({
              id: t.id,
              name: t.name,
              hint: t.token_hint,
              expiresAt: t.expires_at,
              revokedAt: t.revoked_at,
              profileIds: t.allowed_profile_ids ?? null,
            })),
          );
        if (path.startsWith("/api/tokens/") && method === "DELETE") {
          await app.db.transaction((r) =>
            r.revokeCredential(
              "token",
              path.slice("/api/tokens/".length),
              auth.user.id,
            ),
          );
          return json({ ok: true });
        }
        if (path === "/api/files" && method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 50),
            offset = Number(url.searchParams.get("offset") ?? 0);
          if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100 ||
            !Number.isSafeInteger(offset) ||
            offset < 0
          )
            throw new AppError("INVALID_INPUT", "Invalid pagination");
          let filter: FileFilter = {};
          if (url.searchParams.has("source")) {
            app.auth.requireAdmin(auth);
            filter.storageInstanceId = url.searchParams.get("source")!;
            if (!filter.storageInstanceId)
              throw new AppError("INVALID_INPUT", "Invalid storage source");
          }
          if (!isSiteAdmin(auth.user.role)) filter.ownerId = auth.user.id;
          else if (url.searchParams.has("owner")) {
            const owner = url.searchParams.get("owner")!;
            filter.ownerId =
              owner === "guest" ? null : owner === "me" ? auth.user.id : owner;
          }
          for (const field of ["createdFrom", "createdBefore"] as const) {
            const raw = url.searchParams.get(field);
            if (raw !== null) {
              const value = Number(raw);
              if (
                !raw.trim() ||
                !Number.isSafeInteger(value) ||
                value < 0 ||
                value > 8640000000000000
              )
                throw new AppError("INVALID_INPUT", "Invalid date range");
              filter[field] = value;
            }
          }
          if (
            filter.createdFrom !== undefined &&
            filter.createdBefore !== undefined &&
            filter.createdFrom >= filter.createdBefore
          )
            throw new AppError("INVALID_INPUT", "Invalid date range");
          const status = url.searchParams.get("status"),
            mimeType = url.searchParams.get("mimeType"),
            q = url.searchParams.get("q");
          if (status !== null) {
            if (
              ![
                "replica_error",
                "preparing",
                "ready",
                "blocked",
                "failed",
                "deleting",
                "delete_failed",
                "deleted",
              ].includes(status)
            )
              throw new AppError("INVALID_INPUT", "Invalid status");
            filter.status = status as FileFilter["status"];
          }
          if (mimeType !== null) {
            if (!/^image\/[a-zA-Z0-9.+-]{1,80}$/.test(mimeType))
              throw new AppError("INVALID_INPUT", "Invalid MIME type");
            filter.mimeType = mimeType;
          }
          if (q !== null) {
            if (q.length > 2048)
              throw new AppError("INVALID_INPUT", "Search too long");
            filter.q = q.trim();
          }
          if (url.searchParams.has("tag")) {
            filter.tagIds = [...new Set(url.searchParams.getAll("tag"))];
            if (filter.tagIds.length > 100 || filter.tagIds.some((id) => !id))
              throw new AppError("INVALID_INPUT", "Invalid tag filters");
          }
          if (url.searchParams.has("tagMode"))
            filter.tagMode = url.searchParams.get(
              "tagMode",
            ) as FileFilter["tagMode"];
          if (url.searchParams.has("collection")) {
            filter.collectionId = url.searchParams.get("collection")!;
            if (!filter.collectionId)
              throw new AppError("INVALID_INPUT", "Invalid collection");
          }
          for (const key of ["untagged", "uncollected"] as const) {
            if (!url.searchParams.has(key)) continue;
            const value = url.searchParams.get(key);
            if (!["true", "false"].includes(value!))
              throw new AppError(
                "INVALID_INPUT",
                "Invalid organization filter",
              );
            filter[key] = value === "true";
          }
          if (url.searchParams.has("sort")) {
            if (url.searchParams.get("sort") !== "createdAt")
              throw new AppError("INVALID_INPUT", "Invalid sorting");
            filter.sort = "createdAt";
          }
          if (url.searchParams.has("order")) {
            const order = url.searchParams.get("order");
            if (order !== "asc" && order !== "desc")
              throw new AppError("INVALID_INPUT", "Invalid sorting");
            filter.order = order;
          }
          filter = await app.organization.fileFilter(auth, filter);
          const result = await app.db.read(async (r) => {
            const files = await r.files(limit, offset, filter);
            const ownerNames = isSiteAdmin(auth.user.role)
              ? new Map(
                  await Promise.all(
                    [
                      ...new Set(
                        files
                          .map((file) => file.owner_id)
                          .filter((id): id is string => id !== null),
                      ),
                    ].map(
                      async (id) =>
                        [id, (await r.user(id))?.username ?? id] as const,
                    ),
                  ),
                )
              : null;
            const tags = await r.fileTags(files.map((f) => f.id));
            const issues = new Set(
              await r.filesWithReplicaIssues(
                files.map((f) => f.id),
                filter.storageInstanceId,
              ),
            );
            const pending = filter.storageInstanceId
              ? new Set(await r.pendingFileDeletions(files.map((f) => f.id)))
              : null;
            return {
              items: files.map((f) => {
                const item = view(f, app.config.imageOrigin || requestOrigin);
                if (ownerNames)
                  item.ownerName = f.owner_id
                    ? (ownerNames.get(f.owner_id) ?? null)
                    : null;
                item.tags = (tags.get(f.id) ?? []).map(({ id, name }) => ({
                  id,
                  name,
                }));
                item.replicaIssue = issues.has(f.id);
                if (pending) item.backgroundPending = pending.has(f.id);
                return item;
              }),
              total: await r.countFiles(filter),
            };
          });
          return json(result.items, 200, {
            "X-Total-Count": String(result.total),
          });
        }
        if (
          ["/api/files/batch-delete", "/api/files/batch-detach"].includes(
            path,
          ) &&
          method === "POST"
        ) {
          const detach = path.endsWith("batch-detach");
          const { ids, sourceId, includeLast, confirm } = await body(req);
          if (detach) {
            app.auth.requireAdmin(auth);
            if (confirm !== true)
              throw new AppError(
                "INVALID_INPUT",
                "Detach confirmation required",
              );
          }
          if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 100 ||
            ids.some(
              (id) => typeof id !== "string" || !id || id.length > 128,
            ) ||
            new Set(ids).size !== ids.length
          )
            throw new AppError(
              "INVALID_INPUT",
              "Expected 1 to 100 distinct file IDs",
            );
          if (includeLast !== undefined && typeof includeLast !== "boolean")
            throw new AppError("INVALID_INPUT", "Invalid includeLast");
          if (sourceId !== undefined) {
            app.auth.requireAdmin(auth);
            if (typeof sourceId !== "string" || !sourceId.trim())
              throw new AppError("INVALID_INPUT", "Invalid deletion scope");
          }
          return json(
            await (
              detach
                ? app.files.detachMany.bind(app.files)
                : app.files.deleteMany.bind(app.files)
            )(
              ids as string[],
              auth,
              sourceId
                ? {
                    sourceId: sourceId as string,
                    includeLast: includeLast !== false,
                  }
                : undefined,
            ),
          );
        }
        const detachRoute = path.match(
          /^\/api\/files\/([^/]+)(?:\/replicas\/([^/]+))?\/detach$/,
        );
        if (detachRoute && method === "POST") {
          app.auth.requireAdmin(auth);
          const value = await body(req);
          if (
            value.confirm !== true ||
            (value.includeLast !== undefined &&
              typeof value.includeLast !== "boolean")
          )
            throw new AppError("INVALID_INPUT", "Detach confirmation required");
          await app.files.detach(
            detachRoute[1]!,
            detachRoute[2],
            value.includeLast !== false,
          );
          return json({ ok: true });
        }
        const replicaTerminate = path.match(
          /^\/api\/files\/([^/]+)\/replicas\/([^/]+)\/terminate$/,
        );
        if (replicaTerminate && method === "POST") {
          app.auth.requireAdmin(auth);
          if ((await body(req)).confirm !== true)
            throw new AppError(
              "INVALID_INPUT",
              "Confirm marking this replica as deleted",
            );
          await app.files.terminateReplica(
            replicaTerminate[1]!,
            replicaTerminate[2]!,
          );
          return json({ ok: true });
        }
        const replicaDelete = path.match(
          /^\/api\/files\/([^/]+)\/replicas\/([^/]+)$/,
        );
        if (replicaDelete && method === "DELETE") {
          app.auth.requireAdmin(auth);
          const includeLast = url.searchParams.get("includeLast");
          if (includeLast !== null && !["true", "false"].includes(includeLast))
            throw new AppError("INVALID_INPUT", "Invalid includeLast");
          await app.files.deleteReplica(
            replicaDelete[1]!,
            replicaDelete[2]!,
            includeLast !== "false",
          );
          return json({ ok: true });
        }
        const moderation = path.match(
          /^\/api\/files\/([^/]+)\/(preview|unblock)$/,
        );
        if (moderation) {
          app.auth.requireAdmin(auth);
          if (moderation[2] === "preview" && ["GET", "HEAD"].includes(method))
            return await app.files.preview(moderation[1]!, req.signal, {
              method,
            });
          if (moderation[2] === "unblock" && method === "POST") {
            await app.files.unblock(moderation[1]!);
            return json({ ok: true });
          }
        }
        const replacement = path.match(/^\/api\/files\/([^/]+)\/replace$/);
        if (replacement && method === "POST") {
          const input = await body(req);
          if (
            typeof input.replacementId !== "string" ||
            typeof input.replacementPath !== "string"
          )
            throw new AppError(
              "INVALID_INPUT",
              "Replacement ID and path are required",
            );
          const result = await app.files.replace(
            replacement[1]!,
            input.replacementId,
            input.replacementPath,
            auth,
          );
          return json({
            id: result.id,
            url: (app.config.imageOrigin || requestOrigin) + result.path,
          });
        }
        const thumbnail = path.match(/^\/api\/files\/([^/]+)\/thumbnail$/);
        if (thumbnail && ["GET", "HEAD"].includes(method)) {
          app.auth.assertFile(
            auth,
            requireValue(await app.db.read((r) => r.file(thumbnail[1]!))),
          );
          return await app.files.thumbnail(thumbnail[1]!, {
            method,
            ifNoneMatch: req.headers.get("if-none-match"),
          });
        }
        if (path.startsWith("/api/files/")) {
          const id = path.slice("/api/files/".length);
          if (method === "GET") {
            const data = await app.db.read(async (r) => {
              const f = requireValue(await r.file(id));
              app.auth.assertFile(auth, f);
              const result = view(f, app.config.imageOrigin || requestOrigin);
              const organization = await app.organization.read(r, id);
              result.tags = [...organization.tags];
              result.collections = [...organization.collections];
              result.origin = { kind: f.origin_kind, userId: f.origin_user_id };
              const tasks = await r.tasks(id);
              result.uploadProfileId = f.upload_profile_id;
              result.backgroundPending = tasks.some((task) =>
                ["pending", "running"].includes(task.status),
              );
              if (isSiteAdmin(auth.user.role))
                result.processingResults = f.processing_results_json;
              if (isSiteAdmin(auth.user.role))
                result.ownerName = f.owner_id
                  ? ((await r.user(f.owner_id))?.username ?? null)
                  : null;
              return result;
            });
            return json(data);
          }
          if (method === "DELETE") {
            await app.files.delete(id, auth);
            return json({ id, status: "deleting" }, 202);
          }
        }
        throw new AppError("NOT_FOUND", "Endpoint not found", 404);
      }
      if (!["GET", "HEAD"].includes(method))
        throw new AppError("METHOD", "Method not allowed", 405);
      checkHotlink(req, app.config);
      const file = await app.files.find(path);
      return await app.files.access(
        file,
        parseQuery(url.searchParams),
        req.signal,
        { method, ifNoneMatch: req.headers.get("if-none-match") },
      );
    } catch (error) {
      const known = error instanceof AppError;
      const code = known
        ? error.code
        : isPluginError(error)
          ? pluginErrorCode(error.code)
          : "INTERNAL";
      const status = known ? error.status : isPluginError(error) ? 502 : 500;
      console.error(
        JSON.stringify({ event: "request_error", requestId, code }),
      );
      const response = json(
        {
          error: {
            code,
            message: known ? error.message : "Operation failed",
            requestId,
            ...(known && error.fields ? { fields: error.fields } : {}),
          },
        },
        status,
      );
      return req.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response;
    }
  };
}
