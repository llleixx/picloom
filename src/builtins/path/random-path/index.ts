import { PluginError, type Definition } from "../../../../plugin-sdk";

const extensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
  ["image/tiff", "tiff"],
]);

export const randomPath: Definition<"path"> = {
  id: "builtin.random-path",
  name: "Random path",
  description:
    "A stable 32-character random filename derived from the upload ID, without dates or original filenames.",
  translations: {
    "zh-CN": {
      name: "随机路径",
      configSchema: {
        "/properties/directoryDepth": {
          title: "目录层数",
          description: "仅影响存储目录，公开链接保持平铺。",
        },
      },
      description:
        "从随机上传 ID 稳定派生 32 位随机文件名，不包含日期或原始文件名。",
    },
  },
  kind: "path",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      directoryDepth: {
        type: "integer",
        title: "Directory depth",
        enum: [0, 1, 2],
        default: 2,
        description: "Storage directories only; public URLs stay flat.",
      },
    },
    additionalProperties: false,
  },
  async createInstance({ config }) {
    return {
      async generate({ fileId, metadata }) {
        const ext = extensions.get(metadata.mimeType ?? "");
        if (!ext)
          throw new PluginError(
            "UNSUPPORTED",
            "Random path requires a supported final image type",
            false,
            "notApplied",
          );
        // The upload ID is already random; deriving the name keeps retries stable.
        const name = fileId.replaceAll("-", "");
        const logicalKey = name + "." + ext;
        const depth = Number(config.directoryDepth ?? 2);
        const directories = Array.from({ length: depth }, (_, i) =>
          name.slice(i * 2, i * 2 + 2),
        );
        return {
          logicalKey,
          ...(depth
            ? { storageKey: [...directories, logicalKey].join("/") }
            : {}),
        };
      },
    };
  },
};
