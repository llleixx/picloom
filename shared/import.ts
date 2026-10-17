export const importMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/avif",
  "image/tiff",
] as const;
export interface ImportInput {
  publicPrefix: string;
  scope?: string;
  cursor?: string;
  mimeTypes: string[];
}
export interface ImportResult {
  scanned: number;
  imported: number;
  skipped: number;
  conflicts: number;
  failed: number;
  issues: Array<{ logicalKey: string; code: string }>;
  nextCursor: string | null;
}
export function imageMimeFromKey(key: string): string | null {
  const ext = key.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        avif: "image/avif",
        tif: "image/tiff",
        tiff: "image/tiff",
      } as Record<string, string>
    )[ext ?? ""] ?? null
  );
}
