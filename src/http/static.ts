import { builtinSiteIcon } from "../../shared/site-branding";
import { webPages } from "../../shared/web-routes";
import { safePath } from "../infra/files";
import { AppError } from "../core/errors";

export async function webPage(req: Request, root: string): Promise<Response> {
  if (!["GET", "HEAD"].includes(req.method))
    throw new AppError("METHOD", "Method not allowed", 405);
  const path = new URL(req.url).pathname;
  if (path === "/app" || path === "/app/")
    return new Response(null, {
      status: 308,
      headers: { location: "/app/images" },
    });
  const entryPath = await safePath(
    root,
    path.startsWith("/app/") ? "admin.html" : "index.html",
  ).catch(() => null);
  if (!entryPath || !(await Bun.file(entryPath).exists()))
    throw new AppError(
      "FRONTEND_NOT_BUILT",
      "Frontend not built; run bun run build:web",
      503,
    );
  const entry = Bun.file(entryPath);
  const route = path.slice(1);
  const isPage = webPages.includes(
    path === "/" ? path : path.replace(/\/$/, ""),
  );
  let file = entry;
  if (!isPage) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(route);
    } catch {
      throw new AppError("NOT_FOUND", "Resource not found", 404);
    }
    if (!decoded.startsWith("assets/"))
      throw new AppError("NOT_FOUND", "Resource not found", 404);
    const full = await safePath(root, decoded).catch(() => null);
    if (!full || !(await Bun.file(full).exists()))
      throw new AppError("NOT_FOUND", "Resource not found", 404);
    file = Bun.file(full);
  }
  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "content-type": isPage ? "text/html; charset=utf-8" : file.type,
      "content-length": String(file.size),
      "cache-control":
        isPage || path === builtinSiteIcon
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
