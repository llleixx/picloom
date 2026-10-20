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
  defaultLocale: "en-US",
  content: {
    "en-US": {
      name: "Random Path",
      description:
        "A stable 32-character random filename derived from the upload ID, without dates or original filenames.",
      configSchema: {
        "/properties/directoryDepth": {
          title: "Directory shard depth",
          description:
            "Use two filename characters per directory level. Only storage paths change; public URLs stay flat. 0 disables sharding.",
        },
      },
    },
    "zh-CN": {
      name: "随机路径",
      configSchema: {
        "/properties/directoryDepth": {
          title: "分片目录层数",
          description:
            "按文件名每两位分一层目录，仅影响存储路径，公开链接保持平铺。0 表示不分层。",
        },
      },
      description:
        "从随机上传 ID 稳定派生 32 位随机文件名，不包含日期或原始文件名。",
    },
  },

  id: "builtin.random-path",

  kind: "path",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      directoryDepth: {
        type: "integer",

        enum: [0, 1, 2],
        default: 2,
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
