import { PluginError, type Definition } from "../../plugin-sdk";

export default {
  id: "example.date-path",
  name: "Example date path",
  kind: "path",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  async createInstance() {
    return {
      async generate({ fileId, uploadedAt, metadata }) {
        const extension = metadata.mimeType
          ?.split("/")[1]
          ?.replace("svg+xml", "svg")
          .replace("jpeg", "jpg");
        if (!extension)
          throw new PluginError("FORMAT", "Image format is required");
        const day = new Date(uploadedAt)
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", "/");
        return { logicalKey: `${day}/${fileId}.${extension}` };
      },
    };
  },
} satisfies Definition<"path">;
