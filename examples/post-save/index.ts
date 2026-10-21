import { PluginError, type Definition } from "../../plugin-sdk";

export default {
  id: "example.width-review",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  // #region implementation
  defaultLocale: "en-US",
  nameKey: "package.name",
  messages: {
    "en-US": { "package.name": "Example width review", "settings.maxWidth.label": "Maximum width" },
    "zh-CN": { "package.name": "宽度审核示例", "settings.maxWidth.label": "最大宽度" },
  },

  stages: {
    post_save: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          maxWidth: { "x-ui": { labelKey: "settings.maxWidth.label" }, type: "integer", minimum: 1, default: 1280 },
        },
        required: ["maxWidth"],
        additionalProperties: false,
      },
      async createInstance({ config }) {
        const maxWidth = Number(config.maxWidth);
        return {
          async execute({ file }, { signal }) {
            signal.throwIfAborted();
            const width = file.metadata.width;
            if (width === null)
              throw new PluginError("UNSUPPORTED", "Image width is required");
            return {
              status: width > maxWidth ? "block" : "pass",
              details: { width, maxWidth },
            };
          },
        };
      },
    },
  },
  // #endregion implementation
} satisfies Definition<"processor">;
