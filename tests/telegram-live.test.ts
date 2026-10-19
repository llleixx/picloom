import sharp from "sharp";
import { expect, test } from "bun:test";
import { telegramStorage } from "../src/builtins/storage/telegram/index";
import type { InstanceServices, Locator } from "../src/plugins/api";

// Explicit opt-in. No tokens or token-bearing upstream URLs are printed.
test.skipIf(process.env.TELEGRAM_LIVE !== "1")(
  "Telegram live: original document round trip and confirmed message deletion",
  async () => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId)
      throw new Error(
        "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for this opt-in test",
      );
    const services: InstanceServices = {
      images: { sharp },
      log() {},
      async readSecrets() {
        return { value: { botToken }, version: 1 };
      },
      async updateSecrets() {},
      async readState() {
        return { value: {}, version: 1 };
      },
      async updateState() {},
    };
    const plugin = await telegramStorage.createInstance({
      id: "live",
      config: { chatId, timeoutMs: 60000 },
      services,
    });
    const context = {
      signal: AbortSignal.timeout(120000),
      requestId: "telegram-live",
      log() {},
    };
    const id = crypto.randomUUID();
    const bytes = new TextEncoder().encode(
      "picloom Telegram opt-in storage test " + id,
    );
    let locator: Locator = null;
    try {
      const result = await plugin.write(
        {
          operationId: id,
          fileId: id,
          storageKey: id + ".txt",
          file: {
            metadata: {
              byteSize: bytes.length,
              mimeType: "text/plain",
              width: null,
              height: null,
            },
            async openRead() {
              return new Blob([bytes]).stream();
            },
          },
        },
        context,
      );
      locator = result.locator ?? null;
      expect(locator).not.toBeNull();
      for (const mode of ["auto", "stream"] as const) {
        const result = await plugin.read(
          { storageKey: id + ".txt", locator, mode },
          context,
        );
        expect(result.type).toBe("stream");
        if (result.type !== "stream")
          throw new Error("Expected server-side Telegram download");
        expect(
          new Uint8Array(await new Response(result.stream).arrayBuffer()),
        ).toEqual(bytes);
      }
    } finally {
      if (locator !== null)
        await plugin.delete(
          { operationId: "delete-" + id, storageKey: id + ".txt", locator },
          context,
        );
    }
  },
  120000,
);
