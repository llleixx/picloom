import { join } from "node:path";
import { fixture as baseFixture } from "./helpers";

// A test-only processor for configuration, secrets and task lifecycle contracts.
// Persist it as an external package so restart tests exercise normal loading.
export async function fixture(...args: Parameters<typeof baseFixture>) {
  const f = await baseFixture(...args);
  const directory = join(f.root, "plugins", "test-action");
  const manifest = {
    id: "test.action",

    version: "1.0.0",
    kind: "processor",
    apiVersion: 1,
    entry: "index.js",
  };
  try {
    await Bun.write(join(directory, "plugin.json"), JSON.stringify(manifest));
    await Bun.write(
      join(directory, "index.js"),
      `
export default {
  ...${JSON.stringify(manifest)},
  defaultLocale: "en-US", nameKey:"package.name", messages: { "en-US": { "package.name": "Test action" } },
  stages: { post_save: {
    configSchemaVersion: 1,
    configSchema: {
      type: "object",
      properties: {
        url: {type: "string", format: "uri"},
        token: {type: "string", "x-sensitive": true}
      },
      required: ["url"], additionalProperties: false
    },
    async createInstance({config}) {
      return { async execute(input, context) {
        const response = await fetch(config.url, {
          method: "POST", signal: context.signal,
          headers: {"content-type": "application/json", "idempotency-key": input.operationId},
          body: JSON.stringify({url: input.url})
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Test action failed");
        return {};
      }};
    }
  }}
};`,
    );
    await f.app.plugins.loadPackage(directory);
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}
