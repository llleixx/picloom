import { expect, spyOn, test } from "bun:test";
import { fixture } from "./helpers";
import { pipelineData } from "../src/core/pipeline-data";
import type { PostSavePlugin, PostSaveDisposition } from "@picloom/plugin-sdk";

const input = (
  currentDisposition: PostSaveDisposition,
): Parameters<PostSavePlugin["execute"]>[0] => ({
  operationId: "task:notification",
  record: {
    id: "image-id",
    createdAt: 1,
    origin: { kind: "upload", userId: null },
    ownerId: null,
    organization: { tags: [], collections: [] },
  },
  publicPath: "/i/test.png",
  url: "https://images.example/i/test.png",
  currentDisposition,
  previousResults: [
    {
      stepId: "review",
      pluginId: "test.review",
      pluginVersion: "1",
      completedAt: 1,
      disposition: { value: "block", mode: "escalate" },
      details: { label: "<Review>", score: 80 },
    },
  ],
  file: {
    metadata: { mimeType: "image/png", byteSize: 10, width: 1, height: 1 },
    async openRead() {
      throw new Error("Notifications must not read image bytes");
    },
  },
});
const context = () => ({
  signal: new AbortController().signal,
  requestId: "notification-test",
  data: pipelineData(),
  organization: {
    async listTags() {
      return { items: [], total: 0 };
    },
    async listCollections() {
      return { items: [], total: 0 };
    },
    async ensureTag() {
      throw Error("Unexpected create");
    },
    async ensureCollection() {
      throw Error("Unexpected create");
    },
  },
  log() {},
});
async function instance(
  f: Awaited<ReturnType<typeof fixture>>,
  includeDetails = false,
) {
  return f.app.plugins.save({
    pluginId: "builtin.telegram-notification",
    stage: "post_save",
    version: "1.0.0",
    name: "Notify",
    config: {
      statuses: ["block", "delete"],
      chatId: "-100123",
      includeDetails,
      timeoutMs: 100,
    },
    secretEdits: {
      "/botToken": { action: "replace", value: "123:test-token" },
    },
  });
}

test("Telegram notifications filter accumulated status, optionally include details and truncate plain text", async () => {
  const f = await fixture();
  const bodies: any[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    url,
    init,
  ) => {
    expect(String(url)).toBe(
      "https://api.telegram.org/bot123:test-token/sendMessage",
    );
    expect(init!.redirect).toBe("error");
    const body = JSON.parse(String(init!.body));
    bodies.push(body);
    expect(body.chat_id).toBe("-100123");
    expect(body.parse_mode).toBeUndefined();
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    return Response.json({ ok: true, result: { message_id: 7 } });
  }) as typeof fetch);
  try {
    const record = await instance(f);
    expect(JSON.stringify(await f.app.plugins.view(record.id))).not.toContain(
      "test-token",
    );
    const lease = f.app.plugins.acquire(record.id, "post_save");
    try {
      expect(
        await lease.runtime.execute(input("pass"), context()),
      ).toMatchObject({ details: { sent: false } });
      expect(bodies).toHaveLength(0);
      for (const status of ["block", "delete"] as const) {
        expect(await lease.runtime.execute(input(status), context())).toEqual({
          details: { sent: true, messageId: 7 },
        });
        expect(bodies.at(-1).text).toContain(`Current disposition: ${status}`);
        expect(bodies.at(-1).text).not.toContain("Review");
      }
    } finally {
      await lease.release();
    }
    const detailed = await instance(f, true);
    const second = f.app.plugins.acquire(detailed.id, "post_save");
    try {
      await second.runtime.execute(input("block"), context());
      expect(bodies.at(-1).text).toContain("test.review [review]");
      expect(bodies.at(-1).text).toContain('"label": "<Review>"');
      const long = input("delete");
      long.previousResults[0]!.details!.label = "😀".repeat(5000);
      await second.runtime.execute(long, context());
      const text = bodies.at(-1).text as string;
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toEndWith("… (truncated)");
      expect(text.isWellFormed()).toBe(true);
    } finally {
      await second.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});

test("Telegram failures classify provider errors and never expose token-bearing URLs", async () => {
  const f = await fixture();
  let response = () =>
    Promise.resolve(
      Response.json({ ok: false, error_code: 403 }, { status: 403 }),
    );
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () =>
    response()) as unknown as typeof fetch);
  try {
    const record = await instance(f);
    const lease = f.app.plugins.acquire(record.id, "post_save");
    try {
      for (const [code, expected, retryable] of [
        [403, "ACCESS_DENIED", false],
        [429, "RATE_LIMITED", true],
        [500, "SERVICE", false],
      ] as const) {
        response = async () =>
          Response.json(
            { ok: false, error_code: code, description: "123:test-token" },
            { status: code },
          );
        await expect(
          lease.runtime.execute(input("block"), context()),
        ).rejects.toMatchObject({ code: expected, retryable });
      }
      response = async () => Response.json({ ok: true });
      await expect(
        lease.runtime.execute(input("block"), context()),
      ).rejects.toMatchObject({ code: "INVALID_DATA", retryable: false });
      response = async () => {
        throw new Error(
          "https://api.telegram.org/bot123:test-token/sendMessage",
        );
      };
      await expect(
        lease.runtime.execute(input("block"), context()),
      ).rejects.toMatchObject({
        code: "NETWORK",
        message: "Telegram notification outcome is unknown",
        retryable: false,
      });
    } finally {
      await lease.release();
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});

test("moderation followed by Telegram preserves block/delete even when delivery fails", async () => {
  const f = await fixture();
  let status: PostSaveDisposition = "block",
    fail = false;
  const texts: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (
    _url,
    init,
  ) => {
    texts.push(JSON.parse(String(init!.body)).text);
    return fail
      ? Response.json({ ok: false, error_code: 403 }, { status: 403 })
      : Response.json({ ok: true, result: { message_id: 9 } });
  }) as typeof fetch);
  try {
    f.app.plugins.register({
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: { "en-US": { "package.name": "Review" } },

      id: "test.review",

      kind: "processor",
      apiVersion: 1,
      version: "1",
      stages: {
        post_save: {
          configSchemaVersion: 1,
          configSchema: { type: "object" },
          async createInstance() {
            return {
              async execute() {
                return {
                  disposition: { value: status },
                  details: { suggestion: status },
                };
              },
            };
          },
        },
      },
    });
    const chain = await f.app.configuration.savePipeline({
      name: "Review and notify",
      kind: "post_save",
      steps: [
        { pluginId: "test.review", version: "1", config: {} },
        {
          pluginId: "builtin.telegram-notification",
          version: "1.0.0",
          config: {
            statuses: ["block", "delete"],
            timeoutMs: 10000,
            chatId: "-100123",
            includeDetails: true,
          },
          secretEdits: {
            "/botToken": { action: "replace", value: "123:test-token" },
          },
        },
      ],
    });
    const profile = await f.app.configuration.profileEditor(f.profileId);
    await f.app.configuration.saveProfileEditor(
      {
        ...profile,
        expectedVersion: profile.configVersion,
        postSavePipelineId: chain.id,
      },
      profile.id,
    );
    for (const current of ["pass", "block", "delete"] as const) {
      status = current;
      fail = current === "delete";
      const image = await (await f.upload()).json();
      await f.app.files.sweep();
      const file = (await f.app.db.read((r) => r.file(image.id)))!;
      expect(file.status).toBe(
        current === "pass"
          ? "ready"
          : current === "block"
            ? "blocked"
            : "deleted",
      );
      if (current === "pass") expect(texts).toHaveLength(0);
      else expect(texts.at(-1)).toContain(`"suggestion": "${current}"`);
      const task = (await f.app.db.read((r) => r.tasks(image.id))).find(
        (t) => t.kind === "action",
      )!;
      expect(task.status).toBe(fail ? "failed" : "success");
    }
  } finally {
    fetcher.mockRestore();
    await f.close();
  }
});
