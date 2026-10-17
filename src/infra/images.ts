import sharp from "sharp";
import { AppError } from "../core/errors";
import type { Metadata } from "../plugins/api";
// Temporary inputs must not remain open in libvips' operation cache on Windows.
sharp.cache(false);
export async function identify(
  path: string,
  maxPixels: number,
): Promise<Metadata> {
  try {
    const m = await sharp(path, {
      limitInputPixels: maxPixels,
      animated: true,
    }).metadata();
    const mime: Record<string, string> = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      svg: "image/svg+xml",
      gif: "image/gif",
      avif: "image/avif",
      tiff: "image/tiff",
    };
    const type = m.format && mime[m.format];
    if (!type) throw new Error("Unsupported format");
    // EXIF orientations 5–8 swap axes; use one frame for animated inputs.
    const swapAxes =
      m.orientation !== undefined && m.orientation >= 5 && m.orientation <= 8;
    const width = m.width ?? null;
    const height = m.pageHeight ?? m.height ?? null;
    return {
      mimeType: type,
      byteSize: Bun.file(path).size,
      width: swapAxes ? height : width,
      height: swapAxes ? width : height,
      animated: (m.pages ?? 1) > 1,
      alpha: m.hasAlpha,
    };
  } catch {
    throw new AppError(
      "INVALID_IMAGE",
      "Image is invalid or exceeds pixel limit",
      415,
    );
  }
}

/** Internal workspace thumbnail, independent of configured pipelines. */
export async function thumbnail(path: string, maxPixels: number, edge: number) {
  try {
    const { data, info } = await sharp(path, {
      limitInputPixels: maxPixels,
      page: 0,
      pages: 1,
    })
      .autoOrient()
      .resize({
        width: edge,
        height: edge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      metadata: {
        mimeType: "image/webp",
        byteSize: data.byteLength,
        width: info.width,
        height: info.height,
        animated: false,
        alpha: info.channels === 4,
      },
    };
  } catch {
    throw new AppError(
      "INVALID_IMAGE",
      "Cannot generate thumbnail within image limits",
      415,
    );
  }
}
