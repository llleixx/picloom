import { PluginError, type Definition } from "../../plugin-sdk";

export default {
  defaultLocale: "en-US",
  content: { "en-US": { name: "Example width review" } },

  id: "example.width-review",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    post_save: {
      defaultLocale: "en-US",
      content: { "en-US": {} },

      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          maxWidth: { type: "integer", minimum: 1, default: 1280 },
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
} satisfies Definition<"processor">;
