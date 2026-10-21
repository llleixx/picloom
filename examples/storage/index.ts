import { mkdir, link } from "node:fs/promises";
import { resolve } from "node:path";
import {
  safePath,
  writeStream,
  remove,
  PluginError,
  type Definition,
} from "../../plugin-sdk";

export default {
  defaultLocale: "en-US",
  nameKey: "package.name",
  messages: {
    "en-US": {
      "package.name": "Example local storage",
      "settings.root.label": "Root directory",
    },
  },

  id: "example.local-storage",

  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  localDirectory: { configPath: "/root" },
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      root: {
        "x-ui": { labelKey: "settings.root.label" },
        type: "string",

        minLength: 1,
        "x-immutable": true,
      },
    },
    required: ["root"],
    additionalProperties: false,
  },
  async createInstance({ config }) {
    const root = resolve(String(config.root));
    await mkdir(root, { recursive: true });
    return {
      async write({ storageKey, file }, { signal }) {
        const destination = await safePath(root, storageKey, true);
        const temporary = `${destination}.${crypto.randomUUID()}.part`;
        try {
          await writeStream(
            temporary,
            await file.openRead(),
            file.metadata.byteSize ?? Number.MAX_SAFE_INTEGER,
            signal,
          );
          signal.throwIfAborted();
          // A hard link publishes the complete file atomically without overwriting.
          await link(temporary, destination);
          return { locator: null };
        } finally {
          await remove(temporary);
        }
      },
      async read({ storageKey }, { signal }) {
        signal.throwIfAborted();
        const file = Bun.file(await safePath(root, storageKey));
        if (!(await file.exists()))
          throw new PluginError(
            "NOT_FOUND",
            "File not found",
            false,
            "notApplied",
          );
        return { type: "stream", stream: file.stream(), byteSize: file.size };
      },
      async delete({ storageKey }, { signal }) {
        signal.throwIfAborted();
        await remove(await safePath(root, storageKey));
      },
    };
  },
} satisfies Definition<"storage">;
