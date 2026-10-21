import type { Themes } from "../themes/manager";
import { PACKAGE_LIMIT } from "../themes/manager";
import { AppError } from "../core/errors";
export async function themeRequest(
  themes: Themes,
  req: Request,
  path: string,
  body: () => Promise<any>,
): Promise<unknown> {
  const method = req.method;
  if (path === "/api/themes" && method === "GET") return themes.list();
  if (path === "/api/theme" && method === "PUT") {
    const b = await body();
    if (
      b.id !== null &&
      (!Number.isInteger(b.languageRevision) ||
        typeof b.defaultLocale !== "string")
    )
      throw new AppError(
        "INVALID_INPUT",
        "Language selection and revision are required",
      );
    return themes.activate(b.id === null ? null : b);
  }
  if (path === "/api/themes/inspect" && method === "POST") {
    const reader = req.body?.getReader();
    if (!reader) throw new AppError("INVALID_INPUT", "Choose a ZIP package");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > PACKAGE_LIMIT)
          throw new AppError("TOO_LARGE", "Theme package exceeds 20 MB", 413);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return themes.inspect(bytes);
  }
  if (path === "/api/themes/install" && method === "POST") {
    const b = await body();
    return themes.install(b.ticket, b.confirmed === true);
  }
  const route = path.match(
    /^\/api\/themes\/([^/]+)\/([^/]+)(?:\/(config|preview))?$/,
  );
  if (route) {
    const [, id, version, action] = route;
    if (action === "config" && method === "PUT") {
      const b = await body();
      if (!b.language || !Number.isInteger(b.language.languageRevision))
        throw new AppError("INVALID_INPUT", "Language revision is required");
      return themes.configure(id!, version!, b.config, b.language);
    }
    if (action === "preview" && method === "GET")
      return themes.preview(id!, version!);
    if (!action && method === "DELETE") return themes.uninstall(id!, version!);
  }
  throw new AppError("NOT_FOUND", "Theme endpoint not found", 404);
}
