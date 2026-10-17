import type { Definition } from "../../plugin-sdk";
export const datePath: Definition<"path"> = {
  id: "builtin.date-path",
  name: "Date path",
  translations: {
    "zh-CN": {
      name: "日期路径",
    },
  },
  kind: "path",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  async createInstance() {
    return {
      async generate({ fileId, uploadedAt, metadata }) {
        const ext = metadata.mimeType
          ?.split("/")[1]
          ?.replace("svg+xml", "svg")
          .replace("jpeg", "jpg");
        if (!ext) throw new Error("Missing image type");
        return {
          logicalKey: `${new Date(uploadedAt).toISOString().slice(0, 10).replaceAll("-", "/")}/${fileId}.${ext}`,
        };
      },
    };
  },
};
