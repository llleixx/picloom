import type { Definition } from "@picloom/plugin-sdk";
export const datePath: Definition<"path"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "Date Path",
      "package.description": "Organize image paths by UTC year, month and day.",
    },
    "zh-CN": {
      "package.name": "日期路径",
      "package.description": "按 UTC 年、月、日生成图片路径。",
    },
  },

  id: "builtin.date-path",

  kind: "path",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  async createInstance() {
    return {
      async generate({ record, metadata }) {
        const ext = metadata.mimeType
          ?.split("/")[1]
          ?.replace("svg+xml", "svg")
          .replace("jpeg", "jpg");
        if (!ext) throw new Error("Missing image type");
        return {
          logicalKey: `${new Date(record.createdAt).toISOString().slice(0, 10).replaceAll("-", "/")}/${record.id.replaceAll("-", "")}.${ext}`,
        };
      },
    };
  },
};
