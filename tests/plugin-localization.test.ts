import { fieldText } from "../shared/package-localization";
import {
  assertPluginIdentity,
  assertPluginFieldMessages,
} from "../src/plugins/declaration";
import { expect, test } from "bun:test";
import { localizePlugin } from "../shared/plugin-localization";
import { type PluginView } from "../shared/config";
import { fixture } from "./helpers";
import type { Definition } from "../src/plugins/api";
import { messageText } from "../shared/package-localization";
import type { AccessParameterGroup } from "../shared/config";

const plugin: PluginView & import("../shared/config").StageView = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  messages: {
    "en-US": {
      "package.name": "Example",
      "settings.mode.label": "Mode",
      "settings.mode.description": "Read mode",
      "settings.mode.options.stream": "Stream",
      "settings.mode.options.redirect": "Redirect",
      "settings.nested.items.a~1b.label": "Value",

      "groups.read": "read",
    },
    zh: {
      "package.name": "示例",
      "settings.mode.label": "模式",
      "settings.mode.options.stream": "文件流",
      "settings.mode.options.redirect": "重定向",
      "settings.nested.items.a~1b.label": "值",

      "groups.read": "读取",
    },
    "zh-CN": {
      "settings.mode.label": "读取模式",
    },
  },

  id: "test.translated",

  kind: "path",
  version: "1",
  configSchemaVersion: 1,
  configSchema: {
    type: "object",
    properties: {
      mode: {
        "x-ui": {
          labelKey: "settings.mode.label",
          descriptionKey: "settings.mode.description",
          enumKeys: [
            "settings.mode.options.stream",
            "settings.mode.options.redirect",
          ],
          order: 1,
          groupKey: "groups.read",
        },
        type: "string",

        enum: ["stream", "redirect"],

        default: "stream",
      },
      nested: {
        type: "array",
        items: {
          type: "object",
          properties: {
            "a/b": {
              "x-ui": { labelKey: "settings.nested.items.a~1b.label" },
              type: "string",
            },
          },
        },
      },
    },
    allOf: [
      {
        if: { properties: { mode: { const: "stream" } } },
        then: {
          required: ["mode"],
        },
      },
    ],
  },
};

test("plugin localization falls back per field and preserves original metadata and values", () => {
  const original = structuredClone(plugin);
  assertPluginFieldMessages(plugin, plugin.configSchema);
  const display = localizePlugin(plugin, "zh-CN");
  const mode = (display.configSchema.properties as any).mode;
  expect(display.name).toBe("示例");
  expect(fieldText(plugin, "zh-CN", mode["x-ui"]).label).toBe("读取模式");
  expect(fieldText(plugin, "zh-CN", mode["x-ui"]).description).toBe(
    "Read mode",
  );
  expect(fieldText(plugin, "zh-CN", mode["x-ui"]).enumLabels).toEqual([
    "文件流",
    "重定向",
  ]);
  expect(mode.enum).toEqual(["stream", "redirect"]);
  expect(mode.default).toBe("stream");
  expect(mode["x-ui"]).toMatchObject({ order: 1 });
  expect(messageText(plugin, "zh-CN", mode["x-ui"].groupKey)).toBe("读取");
  expect(
    fieldText(
      plugin,
      "zh-CN",
      (display.configSchema.properties as any).nested.items.properties["a/b"][
        "x-ui"
      ],
    ).label,
  ).toBe("值");

  expect(localizePlugin(plugin, "fr-FR").name).toBe("Example");
  expect(plugin).toEqual(original);
});

test("translation validation rejects unsupported changes and invalid references", () => {
  for (const messages of [
    { zh_CN: {} },
    { zh: { "package.name": 42 } },
    { zh: { typo: "组" } },
    { zh: { "package.name": " " } },
  ])
    expect(() =>
      assertPluginIdentity({
        ...plugin,
        messages: { ...plugin.messages, ...messages },
      } as any),
    ).toThrow();
  for (const ui of [
    { labelKey: "missing" },
    { enumKeys: ["package.name"] },
    { widget: "unknown" },
    { group: "inline" },
  ])
    expect(() =>
      assertPluginFieldMessages(plugin, {
        type: "string",
        enum: ["a", "b"],
        "x-ui": ui as any,
      }),
    ).toThrow();
});

test("registration validates translations and management APIs return untranslated descriptors", async () => {
  const f = await fixture();
  try {
    const definition: Definition<"path"> = {
      ...plugin,
      nameKey: plugin.nameKey!,
      kind: "path",
      apiVersion: 1,
      async createInstance() {
        throw new Error("Not called");
      },
    };
    expect(() =>
      f.app.plugins.register({
        ...definition,
        messages: { ...definition.messages, zh: { "package.name": 1 } } as any,
      }),
    ).toThrow();
    f.app.plugins.register(definition);
    const response = await f.request("/api/plugins/test.translated/versions/1");
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.name).toBeUndefined();
    expect(view.defaultLocale).toBe("en-US");
    expect(view.messages).toEqual(plugin.messages);
    expect(view.configSchema.properties.mode.title).toBeUndefined();
    const list = await (await f.request("/api/plugins")).json();
    expect(list.find((p: any) => p.id === plugin.id).messages).toEqual(
      plugin.messages,
    );
  } finally {
    await f.close();
  }
});

test("missing author translations use the resource default; unknown keys stay visible", () => {
  expect(messageText(plugin, "fr-FR", "package.name")).toBe("Example");
  expect(messageText(plugin, "zh-CN", "missing")).toBe("missing");
});

test("plugin authoring requires a default name and keeps schema text out of data rules", () => {
  for (const value of [
    { ...plugin, name: "Legacy name" },
    { ...plugin, translations: {} },
    { ...plugin, defaultLocale: "fr-FR" },
    { ...plugin, defaultLocale: "en-us" },
    { ...plugin, content: { "en-US": { name: " " } } },
    { ...plugin, configSchema: { ...plugin.configSchema, title: "Inline" } },
  ])
    expect(() => {
      assertPluginIdentity(value);
      assertPluginFieldMessages(value, value.configSchema);
    }).toThrow();
});

test("access parameter APIs use a single package catalog", async () => {
  const f = await fixture();
  try {
    f.app.plugins.register({
      id: "test.localized-access",
      kind: "processor",
      version: "1",
      apiVersion: 1,
      defaultLocale: "en-US",
      nameKey: "package.name",
      messages: {
        "en-US": {
          "package.name": "Example",
          "params.mode.label": "Mode",
          "params.hidden.label": "Hidden",
          "params.group": "Parameters",
        },
        "zh-CN": {
          "package.name": "示例",
          "params.mode.label": "模式",
          "params.hidden.label": "隐藏字段",
          "params.group": "参数",
        },
      },
      stages: {
        access: {
          configSchemaVersion: 1,
          configSchema: { type: "object", properties: {} },
          paramsSchema: {
            type: "object",
            properties: {
              mode: {
                "x-ui": {
                  labelKey: "params.mode.label",
                  groupKey: "params.group",
                },
                type: "string",
              },
              hidden: {
                "x-ui": { labelKey: "params.hidden.label" },
                type: "string",
              },
            },
          },
          async createInstance() {
            return {
              async check() {
                return { status: "applicable" };
              },
              async process() {
                return { status: "pass" };
              },
            };
          },
        },
      },
    });
    const access = (await f.app.configuration.pipelines()).find(
      (p) => p.kind === "access",
    )!;
    await f.app.configuration.savePipeline(
      {
        ...access,
        expectedVersion: access.configVersion,
        steps: [
          {
            pluginId: "test.localized-access",
            version: "1",
            config: {},
            enabledParams: ["mode"],
            onNotApplicable: "abort",
          },
        ],
      },
      access.id,
    );
    const response = await f.request("/api/access-parameters");
    expect(response.status).toBe(200);
    const [group] = (await response.json()) as AccessParameterGroup[];
    expect(messageText(group!, "fr-FR", group!.nameKey!)).toBe("Example");
    expect(messageText(group!, "zh-CN", group!.nameKey!)).toBe("示例");
    const display = localizePlugin(group!, "fr-FR");
    expect(
      fieldText(
        group!,
        "fr-FR",
        (display.paramsSchema.properties as any).mode["x-ui"],
      ).label,
    ).toBe("Mode");
    expect(display.paramsSchema.properties).not.toHaveProperty("hidden");
    expect(group!.messages["zh-CN"]).toEqual({
      "package.name": "示例",
      "params.mode.label": "模式",
      "params.group": "参数",
    });
    expect(
      messageText(
        group!,
        "fr-FR",
        (display.paramsSchema.properties as any).mode["x-ui"].groupKey,
      ),
    ).toBe("Parameters");
  } finally {
    await f.close();
  }
});

test("watermark request labels keep their authored translations", async () => {
  const { watermark } = await import("../src/builtins/processor/watermark");
  for (const [locale, label] of [
    ["en-US", "Watermark"],
    ["zh-CN", "水印"],
  ]) {
    const display = localizePlugin(
      {
        ...watermark.stages.access!,
        defaultLocale: watermark.defaultLocale,
        messages: watermark.messages,
      },
      locale!,
    );
    expect(
      fieldText(
        display,
        locale!,
        (display.paramsSchema!.properties as any).watermark["x-ui"],
      ).label,
    ).toBe(label);
  }
});
