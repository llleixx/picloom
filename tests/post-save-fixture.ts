import type { Definition } from "@picloom/plugin-sdk";
export const postSaveFixture: Definition<"processor"> = {
  id: "test.post-save",
  version: "1.0.0",
  apiVersion: 1,
  kind: "processor",
  defaultLocale: "en-US",
  nameKey: "name",
  messages: { "en-US": { name: "Test post-save" } },
  stages: {
    post_save: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: { secretKey: { type: "string", "x-sensitive": true } },
        additionalProperties: false,
      },
      async createInstance() {
        return {
          async execute() {
            return { status: "pass" };
          },
        };
      },
    },
  },
};
