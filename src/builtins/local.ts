import { retainStream } from "../../plugin-sdk/files";
import { scanScope, decodeCursor, encodeCursor } from "./enumeration";
import { mkdir, open, readFile, link, readdir, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  safePath,
  remove,
  writeStream,
  logicalKey as validateKey,
} from "../../plugin-sdk";
import { PluginError, type Definition, type Locator } from "../../plugin-sdk";
export const localStorage: Definition<"storage"> = {
  id: "builtin.local",
  localDirectory: { configPath: "/root" },
  name: "Local storage",
  translations: {
    "zh-CN": {
      name: "本地存储",
      configSchema: {
        "/properties/root": {
          title: "根目录",
        },
      },
    },
  },
  kind: "storage",
  version: "1.0.0",
  apiVersion: 1,
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      root: {
        type: "string",
        title: "Root directory",
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
    const key = (storageKey: string, locator: Locator) => {
      if (locator === null) return objectKey(storageKey);
      if (typeof locator === "object" && typeof locator.key === "string")
        return locator.key;
      throw new PluginError("LOCATOR", "Invalid local locator");
    };
    const objectKey = (logical: string) => {
      const value = validateKey(logical);
      if (value === ".picloom" || value.startsWith(".picloom/"))
        throw new PluginError(
          "LOCATOR",
          "Reserved storage directory",
          false,
          "notApplied",
        );
      return value;
    };
    const recordPath = async (logical: string) =>
      safePath(
        root,
        `.picloom/${createHash("sha256").update(objectKey(logical)).digest("hex")}.json`,
        true,
      );
    return {
      async listFiles({ scope: inputScope, cursor, limit }, ctx) {
        const scope = scanScope(inputScope);
        if (scope) objectKey(scope);
        type Frame = { directory: string; after: string };
        const stack = decodeCursor<Frame[]>(cursor, scope) ?? [
          { directory: scope, after: "" },
        ];
        if (
          !Array.isArray(stack) ||
          !stack.length ||
          stack.some(
            (f) =>
              !f ||
              typeof f.directory !== "string" ||
              typeof f.after !== "string" ||
              (scope &&
                f.directory !== scope &&
                !f.directory.startsWith(scope + "/")),
          )
        )
          throw new PluginError("INVALID_CURSOR", "Invalid scan cursor");
        const items: Array<{ storageKey: string; byteSize: number }> = [];
        // Bound directory work too: an empty page may still have a next cursor.
        let work = 0;
        while (stack.length && items.length < limit && work++ < limit * 4) {
          ctx.signal.throwIfAborted();
          const frame = stack.at(-1)!;
          const directory = frame.directory
            ? await safePath(root, frame.directory)
            : root;
          const entries = (await readdir(directory, { withFileTypes: true }))
            .filter((e) => e.name > frame.after)
            .sort((a, b) => (a.name < b.name ? -1 : 1));
          if (!entries.length) {
            stack.pop();
            continue;
          }
          for (const entry of entries) {
            ctx.signal.throwIfAborted();
            frame.after = entry.name;
            if (
              entry.isSymbolicLink() ||
              (!frame.directory && entry.name === ".picloom")
            )
              continue;
            const name = frame.directory
              ? frame.directory + "/" + entry.name
              : entry.name;
            if (entry.isDirectory()) {
              stack.push({ directory: name, after: "" });
              break;
            }
            if (entry.isFile() && !entry.name.endsWith(".part")) {
              const stat = await lstat(join(directory, entry.name));
              if (stat.isFile())
                items.push({ storageKey: name, byteSize: stat.size });
              if (items.length >= limit) break;
            }
          }
        }
        return {
          items,
          nextCursor: stack.length ? encodeCursor(scope, stack) : null,
        };
      },
      async write({ operationId, storageKey, file }, ctx) {
        ctx.signal.throwIfAborted();
        const target = await safePath(root, objectKey(storageKey), true);
        const record = await recordPath(storageKey);
        const temporary = join(
          dirname(target),
          `.${createHash("sha256").update(operationId).digest("hex")}.part`,
        );
        let existing;
        try {
          existing = JSON.parse(await readFile(record, "utf8"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        if (
          existing &&
          (existing.operationId !== operationId ||
            existing.storageKey !== storageKey ||
            existing.size !== file.metadata.byteSize)
        )
          throw new PluginError(
            "CONFLICT",
            "Object belongs to another operation",
            false,
            "notApplied",
          );
        if (!existing && (await Bun.file(target).exists()))
          throw new PluginError(
            "CONFLICT",
            "Object already exists",
            false,
            "notApplied",
          );
        if (!existing) {
          const f = await open(record, "wx");
          try {
            await f.writeFile(
              JSON.stringify({
                operationId,
                storageKey,
                size: file.metadata.byteSize,
              }),
            );
            await f.sync();
          } finally {
            await f.close();
          }
        }
        if (await Bun.file(target).exists()) {
          if (
            !existing?.inode ||
            (await lstat(target)).ino !== existing.inode ||
            Bun.file(target).size !== file.metadata.byteSize
          )
            throw new PluginError(
              "CORRUPT",
              "Existing object has incorrect size",
            );
          return { locator: null };
        }
        await remove(temporary);
        try {
          const size = await writeStream(
            temporary,
            await file.openRead(),
            file.metadata.byteSize!,
            ctx.signal,
          );
          if (size !== file.metadata.byteSize)
            throw new PluginError("INCOMPLETE", "Incomplete input");
          await Bun.write(
            record,
            JSON.stringify({
              operationId,
              storageKey,
              size,
              inode: (await lstat(temporary)).ino,
            }),
          );
          await link(temporary, target);
          await remove(temporary);
          return { locator: null };
        } catch (e) {
          await remove(temporary);
          throw e;
        }
      },
      async recoverWrite({ operationId, storageKey, expectedSize }) {
        const target = await safePath(root, objectKey(storageKey));
        const record = await recordPath(storageKey);
        let saved;
        try {
          saved = JSON.parse(await readFile(record, "utf8"));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT")
            return {
              status: (await Bun.file(target).exists())
                ? "unknown"
                : "notStored",
            };
          throw e;
        }
        if (
          saved.operationId !== operationId ||
          saved.storageKey !== storageKey ||
          saved.size !== expectedSize
        )
          return { status: "unknown" };
        if (await Bun.file(target).exists())
          return saved.inode &&
            (await lstat(target)).ino === saved.inode &&
            Bun.file(target).size === expectedSize
            ? { status: "stored", locator: null }
            : { status: "unknown" };
        await remove(
          join(
            dirname(target),
            `.${createHash("sha256").update(operationId).digest("hex")}.part`,
          ),
        );
        await remove(record);
        return { status: "notStored" };
      },
      async read({ storageKey, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const path = await safePath(root, key(storageKey, locator));
        if (!(await Bun.file(path).exists()))
          throw new PluginError("NOT_FOUND", "Stored object not found");
        return {
          type: "stream",
          stream: retainStream(Bun.file(path).stream(), () => {}, ctx.signal),
          byteSize: Bun.file(path).size,
        };
      },
      async delete({ storageKey, locator }, ctx) {
        ctx.signal.throwIfAborted();
        const path = await safePath(root, key(storageKey, locator));
        await remove(path);
        await remove(await recordPath(storageKey));
      },
    };
  },
};
