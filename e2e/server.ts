import { maxUploadBodyBytes } from "../shared/runtime-settings";
import { bootstrap, initializeDevelopment } from "../src/bootstrap";
import { handler } from "../src/http/app";
import sharp from "sharp";
const scenario = process.env.E2E_SCENARIO;
if (scenario === "backup") {
  await import("./backup-server");
  process.exit(0);
}
const app = await bootstrap(
  {
    root: process.env.E2E_ROOT!,
    encryptionKey: "cd".repeat(32),
    origin: "http://127.0.0.1",
    secureCookie: false,
    ...(process.env.E2E_WEB_ROOT ? { webRoot: process.env.E2E_WEB_ROOT } : {}),
    ...(scenario === "queue"
      ? { maxUploadBytes: 1024, uploadConcurrency: 2 }
      : {}),
    ...(scenario === "delete-failure" ? { retryLimit: 1 } : {}),
  },
  scenario === "delete-failure"
    ? {
        beforeDelete: async () => {
          throw new Error("test deletion failure");
        },
      }
    : scenario === "queue"
      ? {
          beforeWrite: async () => {
            await Bun.sleep(250);
          },
        }
      : {},
);
await app.auth.initialize("admin", "test-password-123");
// Exercise post-save forms and execution without depending on an external service.
if (scenario === "configuration")
  app.plugins.register({
    defaultLocale: "en-US",
    nameKey: "package.name",
    messages: {
      "en-US": {
        "package.name": "Test webhook",
        "settings.url.label": "Target URL",
        "settings.token.label": "Bearer Token",
      },
    },

    id: "test.webhook",

    kind: "processor",
    version: "1.0.0",
    apiVersion: 1,
    stages: {
      post_save: {
        configSchemaVersion: 1,
        configSchema: {
          type: "object",
          properties: {
            url: {
              "x-ui": { labelKey: "settings.url.label" },
              type: "string",
              format: "uri",
            },
            token: {
              "x-ui": { labelKey: "settings.token.label" },
              type: "string",

              "x-sensitive": true,
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        async createInstance({ config, services }) {
          const secrets = (await services.readSecrets()).value;
          return {
            async execute(input, context) {
              const response = await fetch(String(config.url), {
                method: "POST",
                signal: context.signal,
                headers: {
                  "content-type": "application/json",
                  authorization: "Bearer " + secrets.token,
                },
                body: JSON.stringify({ url: input.url }),
              });
              await response.body?.cancel();
              if (!response.ok) throw new Error("Test webhook failed");
              return { status: "pass" };
            },
          };
        },
      },
    },
  });
if (scenario === "configuration")
  app.plugins.register({
    defaultLocale: "en-US",
    nameKey: "package.name",
    messages: {
      "en-US": {
        "package.name": "Schema test",
        "settings.enabled.label": "Show details",
        "settings.empty.label": "Empty settings",
        "settings.emptySecret.label": "Empty secret",
        "settings.detail.label": "Details",
        "settings.nested.label": "Nested settings",
        "settings.nested.label.label": "Nested name",
        "settings.items.label": "Items",
        "settings.nulls.label": "Null items",
        "settings.items.items.name.label": "Item name",
        "settings.items.items.tags.label": "Item tags",
        "settings.secretItems.label": "Secret items",
      },
    },

    id: "test.form",

    kind: "path",
    version: "1",
    apiVersion: 1,
    configSchemaVersion: 1,
    configSchema: {
      type: "object",
      properties: {
        empty: {
          type: "object",
          properties: {},
          "x-ui": { labelKey: "settings.empty.label" },
        },
        toString: { type: "string" as const },
        emptySecret: {
          type: "string",
          "x-sensitive": true,
          "x-ui": { labelKey: "settings.emptySecret.label" },
        },
        enabled: {
          "x-ui": { labelKey: "settings.enabled.label" },
          type: "boolean",
          default: false,
        },
        detail: {
          "x-ui": {
            labelKey: "settings.detail.label",
            visibleWhen: { path: "/enabled", equals: true },
          },
          type: "string",
        },
        nested: {
          "x-ui": { labelKey: "settings.nested.label", advanced: true },
          type: "object",

          properties: {
            label: {
              "x-ui": { labelKey: "settings.nested.label.label" },
              type: "string",
              default: "default",
            },
          },
        },
        items: {
          "x-ui": { labelKey: "settings.items.label" },
          type: "array",

          items: {
            type: "object",
            properties: {
              name: {
                "x-ui": { labelKey: "settings.items.items.name.label" },
                type: "string",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                "x-ui": { labelKey: "settings.items.items.tags.label" },
              },
            },
            required: ["name"],
          },
        },
        nulls: {
          "x-ui": { labelKey: "settings.nulls.label" },
          type: "array",
          items: { type: "null", default: null },
        },
        secretItems: {
          "x-ui": { labelKey: "settings.secretItems.label" },
          type: "array",

          items: {
            type: "object",
            properties: { token: { type: "string", "x-sensitive": true } },
            required: ["token"],
          },
        },
      },
      if: { properties: { enabled: { const: true } }, required: ["enabled"] },
      then: { required: ["detail"] },
      additionalProperties: false,
    },
    async createInstance() {
      return {
        async generate(input) {
          return { logicalKey: "test/" + input.fileId + ".png" };
        },
      };
    },
  });
const profile =
  scenario === "no-profile" ? null : await initializeDevelopment(app);
if (scenario === "moderation" && profile) {
  app.plugins.register({
    defaultLocale: "en-US",
    nameKey: "package.name",
    messages: { "en-US": { "package.name": "Review" } },

    id: "test.review",

    version: "1",
    apiVersion: 1,
    kind: "processor",
    stages: {
      post_save: {
        configSchemaVersion: 1,
        configSchema: { type: "object", properties: {} },
        async createInstance() {
          return {
            async execute() {
              return {
                status: "block",
                details: {
                  label: "Test content",
                  score: 82,
                  labels: [{ label: "Test", score: 82 }],
                },
              };
            },
          };
        },
      },
    },
  });
  const current = await app.configuration.profileEditor(profile);
  if (!current.postSavePipelineId) {
    const chain = await app.configuration.savePipeline({
      name: "Review",
      kind: "post_save",
      steps: [{ pluginId: "test.review", version: "1", config: {} }],
    });
    await app.configuration.saveProfileEditor(
      {
        ...current,
        expectedVersion: current.configVersion,
        postSavePipelineId: chain.id,
      },
      current.id,
    );
  }
}
const handle = handler(app);
let uploadsInFlight = 0,
  uploadPeak = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.E2E_PORT ?? 0),
  maxRequestBodySize: maxUploadBodyBytes,
  async fetch(req) {
    if (
      scenario === "configuration" &&
      new URL(req.url).pathname === "/test-hook"
    ) {
      await req.json();
      return new Response(null, {
        status:
          req.headers.get("authorization") === "Bearer test-token" ? 204 : 401,
      });
    }
    const upload =
      req.method === "POST" && new URL(req.url).pathname === "/api/files";
    if (upload) {
      uploadsInFlight++;
      uploadPeak = Math.max(uploadPeak, uploadsInFlight);
      console.log(JSON.stringify({ uploadPeak }));
    }
    try {
      return await handle(req);
    } finally {
      if (upload) uploadsInFlight--;
    }
  },
});
app.config.origin =
  process.env.E2E_PUBLIC_ORIGIN ??
  (scenario === "dev" ? "http://127.0.0.1:5173" : server.url.origin);
app.config.imageOrigin =
  scenario === "image-origin"
    ? server.url.origin.replace("127.0.0.1", "localhost")
    : (process.env.E2E_IMAGE_ORIGIN ?? app.config.origin);
if (scenario === "image-origin") {
  app.config.hotlinkEnabled = true;
  app.config.hotlinkAllowEmpty = false;
}
if (scenario === "seed" && !(await app.db.read((r) => r.countFiles()))) {
  const login = await app.auth.login("admin", "test-password-123", "seed");
  const auth = await app.auth.authenticate(
    new Request(server.url, {
      headers: { cookie: app.auth.cookie(login.secret) },
    }),
  );
  const palettes = [
    ["#dce7ee", "#7793a2", "#486471"],
    ["#f6dfcc", "#d9a184", "#9d756b"],
    ["#dedfe9", "#9294b5", "#606e8b"],
    ["#dce8d8", "#9aa987", "#6b8067"],
  ];
  for (let i = 0; i < 25; i++) {
    const [sky, mountain, foreground] = palettes[i % palettes.length]!;
    const bytes = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${sky}"/><circle cx="${150 + (i % 3) * 140}" cy="140" r="60" fill="#fff7e9"/><path d="M0 340L180 160L370 360L500 220L640 340V480H0Z" fill="${mountain}"/><path d="M0 400Q180 280 350 400T640 370V480H0Z" fill="${foreground}"/></svg>`,
      ),
    )
      .png()
      .toBuffer();
    await app.files.upload(
      new File([new Uint8Array(bytes)], "seed.png"),
      profile!,
      auth,
      new AbortController().signal,
    );
  }
}
let sweeping: Promise<unknown> | undefined;
const timer = setInterval(() => {
  if (sweeping) return;
  sweeping = app.files
    .sweep()
    .catch(() => {})
    .finally(() => (sweeping = undefined));
}, 200);
console.log(JSON.stringify({ ready: server.url.origin }));
// Stdin shutdown is portable on Windows and lets the test await graceful cleanup.
for await (const _ of Bun.stdin.stream()) break;
clearInterval(timer);
await server.stop(true);
await app.files.tasks.close();
await sweeping;
await app.close();
