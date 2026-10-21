import { PluginError, type Definition } from "@picloom/plugin-sdk";
import manifest from "../plugin.json";

// Narrow JSON strings through validation, rather than duplicating identity values.
const { kind, apiVersion } = manifest;
if (kind !== "path" || apiVersion !== 1)
  throw new Error("This implementation requires kind=path and apiVersion=1");

export default {
  id: manifest.id,
  defaultLocale: "en-US",
  nameKey: "package.name",
  messages: { "en-US": { "package.name": "My date path" } },
  version: manifest.version,
  kind,
  apiVersion,
  configSchemaVersion: 1,
  async createInstance() {
    return {
      async generate({ fileId, uploadedAt, metadata }) {
        const extensions: Record<string, string> = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/avif": "avif",
          "image/svg+xml": "svg",
        };
        const extension = extensions[metadata.mimeType ?? ""];
        if (!extension)
          throw new PluginError("UNSUPPORTED", "Unsupported image format");
        const date = new Date(uploadedAt)
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", "/");
        return { logicalKey: `${date}/${fileId}.${extension}` };
      },
    };
  },
} satisfies Definition<"path">;
