import type { Settings } from "../config";
export interface ImageRequest {
  method?: string;
  ifNoneMatch?: string | null;
}
export function publicCacheControl(config: Settings) {
  return `public, max-age=${config.imageCacheMaxAge}, must-revalidate`;
}
export function imageHeaders(
  config: Settings,
  mime: string,
  etag?: string,
  size?: number | null,
) {
  const headers = new Headers({
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "cache-control": !etag ? "no-store" : publicCacheControl(config),
  });
  if (mime.split(";", 1)[0]!.trim().toLowerCase() === "image/svg+xml")
    headers.set(
      "content-security-policy",
      "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
  if (etag) headers.set("etag", etag);
  if (size != null) headers.set("content-length", String(size));
  return headers;
}
export function notModified(request: ImageRequest, etag: string) {
  return !!request.ifNoneMatch?.split(",").some((tag) => {
    const value = tag.trim();
    return (
      value === "*" || value.replace(/^W\//, "") === etag.replace(/^W\//, "")
    );
  });
}
export function emptyImageResponse(
  request: ImageRequest,
  headers: Headers,
): Response | null {
  const etag = headers.get("etag");
  if (etag && notModified(request, etag)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return request.method === "HEAD" ? new Response(null, { headers }) : null;
}

// Cache hits own an open file stream, including when HEAD/304 skips the body.
export async function derivedImageResponse(
  result: import("./cache").ImageResult | import("./cache").CachedImage,
  request: ImageRequest,
  headers: Headers,
) {
  const empty = emptyImageResponse(request, headers);
  if (empty) {
    if ("stream" in result) await result.stream.cancel();
    return empty;
  }
  return new Response(
    "stream" in result
      ? result.stream
      : (result.bytes as Uint8Array<ArrayBuffer>),
    { headers },
  );
}
