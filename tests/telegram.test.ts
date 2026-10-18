import sharp from "sharp";
import { afterEach, expect, spyOn, test } from "bun:test";
import { telegramStorage } from "../src/builtins/telegram";
import type { FileInput, InstanceServices } from "../src/plugins/api";

const botToken = "123456:test-secret-token";
const bytes = new Uint8Array([1, 2, 3, 4]);
const context = {
  signal: AbortSignal.timeout(30000),
  requestId: "test",
  log() {},
};
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
const file: FileInput = {
  metadata: {
    byteSize: bytes.length,
    mimeType: "image/png",
    width: 1,
    height: 1,
  },
  async openRead() {
    return new Blob([bytes]).stream();
  },
};
const writeInput = {
  operationId: "op",
  fileId: "local-file",
  storageKey: "images/a.png",
  file,
};
const locator = {
  fileId: "tg_file",
  chatId: "-100123",
  messageId: 123,
  byteSize: bytes.length,
  mimeType: "image/png",
};
const runtime = () =>
  telegramStorage.createInstance({
    id: "test",
    config: { chatId: "-100123" },
    services,
  });
const uploadResult = () =>
  Response.json({
    ok: true,
    result: {
      message_id: 123,
      chat: { id: -100123 },
      document: { file_id: "tg_file", file_size: bytes.length },
    },
  });
const fileResult = () =>
  Response.json({
    ok: true,
    result: {
      file_id: "tg_file",
      file_size: bytes.length,
      file_path: "documents/file.png",
    },
  });
let mock: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  mock?.mockRestore();
  mock = undefined;
});
function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  mock = spyOn(globalThis, "fetch").mockImplementation(((input, init) =>
    handler(String(input), init)) as typeof fetch);
}

test("Telegram uploads original bytes as a document and keeps secrets out of the locator", async () => {
  mockFetch(async (url, init) => {
    expect(url).toBe(`https://api.telegram.org/bot${botToken}/sendDocument`);
    expect(init?.redirect).toBe("error");
    const form = init?.body as FormData;
    expect(form.get("chat_id")).toBe("-100123");
    expect(form.get("disable_content_type_detection")).toBe("true");
    expect(form.get("photo")).toBeNull();
    const document = form.get("document") as File;
    expect(document.name).toBe("local-file.png");
    expect(document.type).toBe("image/png");
    expect(new Uint8Array(await document.arrayBuffer())).toEqual(bytes);
    return uploadResult();
  });
  const plugin = await runtime();
  expect(plugin.recoverWrite).toBeUndefined();
  const result = await plugin.write(writeInput, context);
  expect(result.locator).toEqual(locator);
  expect(JSON.stringify(result)).not.toContain(botToken);
});

test("Telegram auto and forced stream reads proxy files without a token-bearing redirect", async () => {
  let downloads = 0;
  mockFetch((url, init) => {
    expect(init?.redirect).toBe("error");
    if (url.endsWith("/getFile")) {
      expect((init?.body as URLSearchParams).get("file_id")).toBe("tg_file");
      return fileResult();
    }
    expect(url).toBe(
      `https://api.telegram.org/file/bot${botToken}/documents/file.png`,
    );
    downloads++;
    return new Response(bytes);
  });
  const plugin = await runtime();
  for (const mode of ["auto", "stream"] as const) {
    const result = await plugin.read(
      { storageKey: "a.png", locator, mode },
      context,
    );
    expect(result.type).toBe("stream");
    if (result.type !== "stream") throw new Error();
    expect(result.mimeType).toBe("image/png");
    expect(result.byteSize).toBe(bytes.length);
    expect(
      new Uint8Array(await new Response(result.stream).arrayBuffer()),
    ).toEqual(bytes);
  }
  expect(downloads).toBe(2);
});

test("Telegram rejects unknown, excessive and mismatched file sizes before a remote write", async () => {
  mockFetch(() => {
    throw new Error("must not contact Telegram");
  });
  const plugin = await runtime();
  for (const size of [null, 20_000_001, -1, 3, 5]) {
    await expect(
      plugin.write(
        {
          ...writeInput,
          file: { ...file, metadata: { ...file.metadata, byteSize: size } },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT", outcome: "notApplied" });
  }
  expect(mock).not.toHaveBeenCalled();
});

test("Telegram lost upload responses and malformed successes remain unknown without automatic retries", async () => {
  const plugin = await runtime();
  for (const behavior of [
    () => {
      throw new TypeError(
        `connection failed at https://api.telegram.org/bot${botToken}/sendDocument`,
      );
    },
    () => Response.json({ ok: true, result: { message_id: 123 } }),
    () => new Response("gateway failed", { status: 502 }),
    () => Response.json({ ok: false, error_code: 503, description: botToken }),
  ]) {
    mockFetch(behavior);
    try {
      await plugin.write(writeInput, context);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ outcome: "unknown", retryable: false });
      expect(String(error)).not.toContain(botToken);
    }
    mock?.mockRestore();
  }
});

test("Telegram explicit API failures are not reported as uploads or successful deletion", async () => {
  const plugin = await runtime();
  for (const code of [400, 401, 403, 429]) {
    mockFetch(() =>
      Response.json({ ok: false, error_code: code, description: botToken }),
    );
    await expect(plugin.write(writeInput, context)).rejects.toMatchObject({
      outcome: "notApplied",
      retryable: code === 429,
    });
    await expect(
      plugin.delete(
        { operationId: "delete", storageKey: "a.png", locator },
        context,
      ),
    ).rejects.toMatchObject({ outcome: "notApplied", retryable: code === 429 });
    mock?.mockRestore();
  }
});

test("Telegram deletion requires explicit true and addresses the saved message", async () => {
  const plugin = await runtime();
  for (const result of [false, {}, true]) {
    mockFetch((url, init) => {
      expect(url.endsWith("/deleteMessage")).toBe(true);
      expect((init?.body as URLSearchParams).get("chat_id")).toBe(
        locator.chatId,
      );
      expect((init?.body as URLSearchParams).get("message_id")).toBe(
        String(locator.messageId),
      );
      return Response.json({ ok: true, result });
    });
    const promise = plugin.delete(
      { operationId: "delete", storageKey: "a.png", locator },
      context,
    );
    if (result === true) await promise;
    else
      await expect(promise).rejects.toMatchObject({
        code: "SERVICE",
        outcome: "unknown",
      });
    mock?.mockRestore();
  }
});

test("Telegram rejects legacy or malformed locators and unsafe getFile paths", async () => {
  const plugin = await runtime();
  for (const value of [
    null,
    "tg_file",
    {},
    { ...locator, fileId: "https://elsewhere" },
  ])
    await expect(
      plugin.read(
        { storageKey: "a.png", locator: value, mode: "auto" },
        context,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const path of [
    "../private",
    "/absolute",
    "https://elsewhere/file",
    "documents/%2e%2e/file",
    "documents/file?token=x",
  ]) {
    mockFetch(() =>
      Response.json({
        ok: true,
        result: {
          file_id: "tg_file",
          file_size: bytes.length,
          file_path: path,
        },
      }),
    );
    await expect(
      plugin.read({ storageKey: "a.png", locator, mode: "auto" }, context),
    ).rejects.toMatchObject({ code: "INVALID_DATA" });
    expect(mock).toHaveBeenCalledTimes(1);
    mock?.mockRestore();
  }
});

test("Telegram deletion retries accept only the exact missing-message response", async () => {
  const plugin = await runtime();
  for (const description of [
    "Bad Request: message to delete not found",
    "Bad Request: message can't be deleted",
    "Forbidden: bot is not a member of the channel chat",
    "message to delete not found",
  ]) {
    mockFetch(() =>
      Response.json(
        { ok: false, error_code: 400, description },
        { status: 400 },
      ),
    );
    const action = plugin.delete(
      { operationId: "retry", storageKey: "a.png", locator },
      context,
    );
    if (description === "Bad Request: message to delete not found")
      await action;
    else
      await expect(action).rejects.toMatchObject({
        code: "UNSUPPORTED",
        outcome: "notApplied",
      });
    mock?.mockRestore();
  }
});

test("Telegram late download errors cannot expose the bot token", async () => {
  mockFetch((url) =>
    url.endsWith("/getFile")
      ? fileResult()
      : new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(
                new Error(
                  `failed https://api.telegram.org/file/bot${botToken}/documents/file.png`,
                ),
              );
            },
          }),
        ),
  );
  const result = await (
    await runtime()
  ).read({ storageKey: "a.png", locator, mode: "stream" }, context);
  if (result.type !== "stream") throw new Error();
  try {
    await new Response(result.stream).arrayBuffer();
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "NETWORK" });
    expect(String(error)).not.toContain(botToken);
  }
});

test("Telegram transient deletion failures can retry without retrying ambiguous uploads", async () => {
  const plugin = await runtime();
  for (const behavior of [
    () => {
      throw new TypeError("Connection lost");
    },
    () => new Response("Unavailable", { status: 503 }),
    () => Response.json({ ok: false, error_code: 503 }),
  ]) {
    mockFetch(behavior);
    await expect(
      plugin.delete(
        { operationId: "delete", storageKey: "a.png", locator },
        context,
      ),
    ).rejects.toMatchObject({ retryable: true, outcome: "unknown" });
    mock?.mockRestore();
  }
});
