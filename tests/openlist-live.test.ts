import sharp from "sharp";
import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { openListStorage } from "../src/builtins/storage/openlist/index";
import type { Locator } from "../src/plugins/api";

test.skipIf(process.env.OPENLIST_LIVE !== "1")(
  "OpenList real endpoint upload/read/delete smoke",
  async () => {
    const endpoint = process.env.OPENLIST_ENDPOINT;
    const root = process.env.OPENLIST_ROOT;
    const token = process.env.OPENLIST_TOKEN;
    if (!endpoint || !root || !token)
      throw new Error(
        "OPENLIST_ENDPOINT, OPENLIST_ROOT and OPENLIST_TOKEN are required",
      );
    const config = { endpoint, root };
    expect(await openListStorage.validateConfig!(config)).toEqual([]);
    const runtime = await openListStorage.createInstance({
      id: "openlist-live",
      config,
      services: {
        images: { sharp },
        log() {},
        async readSecrets() {
          return { value: { token }, version: 1 };
        },
        async updateSecrets() {},
        async readState() {
          return { value: {}, version: 1 };
        },
        async updateState() {},
      },
    });
    const fileId = randomUUID();
    const storageKey = fileId + ".svg";
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>',
    );
    const context = {
      signal: AbortSignal.timeout(60000),
      requestId: fileId,
      log() {},
    };
    // Known path permits cleanup even if the upload response is lost.
    const locator: Locator = null;
    try {
      const result = await runtime.write(
        {
          operationId: fileId,
          fileId,
          storageKey,
          file: {
            metadata: {
              byteSize: bytes.length,
              mimeType: "image/svg+xml",
              width: 1,
              height: 1,
            },
            async openRead() {
              return new Blob([bytes]).stream();
            },
          },
        },
        context,
      );
      expect(result.locator).toEqual(locator);
      const auto = await runtime.read(
        { storageKey, locator, mode: "auto" },
        context,
      );
      expect(auto.type).toBe("redirect");
      const content = await runtime.read(
        { storageKey, locator, mode: "stream" },
        context,
      );
      expect(content.type).toBe("stream");
      if (content.type === "stream")
        expect(
          new Uint8Array(await new Response(content.stream).arrayBuffer()),
        ).toEqual(bytes);
    } finally {
      // This only targets this test's randomly generated object.
      const cleanup = { ...context, signal: AbortSignal.timeout(60000) };
      await runtime.delete(
        { operationId: fileId, storageKey, locator },
        cleanup,
      );
      await runtime.delete(
        { operationId: fileId, storageKey, locator },
        cleanup,
      );
      await runtime.dispose?.();
    }
  },
  180000,
);
