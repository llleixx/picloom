import type { Settings } from "../config";
import { AppError } from "../core/errors";

export function checkHotlink(request: Request, config: Settings) {
  if (!config.hotlinkEnabled) return;
  const referer = request.headers.get("referer");
  if (!referer && config.hotlinkAllowEmpty) return;
  if (referer) {
    try {
      const url = new URL(referer);
      if (["http:", "https:"].includes(url.protocol)) {
        // The site itself must be able to display uploads and process previews.
        if (url.origin === config.origin || url.origin === config.imageOrigin)
          return;
        const host = url.hostname.toLowerCase();
        if (
          config.hotlinkAllowedHosts.some((allowed) =>
            allowed.startsWith("*.")
              ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2)
              : host === allowed,
          )
        )
          return;
      }
    } catch {
      /* Malformed Referer is not an allowed source. */
    }
  }
  throw new AppError(
    "HOTLINK_DENIED",
    "Image embedding is not allowed from this source",
    403,
  );
}
