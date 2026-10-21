import { expect, test } from "bun:test";
import {
  assertMessageCatalog,
  assertFieldText,
  fieldText,
  messageText,
  schemaNodes,
  type MessageCatalog,
} from "../shared/package-localization";

const catalog: MessageCatalog = {
  defaultLocale: "en-US",
  messages: {
    "en-US": {
      label: "Layout",
      help: "Choose layout",
      wide: "Wide",
      compact: "Compact",
    },
    zh: { label: "布局", wide: "宽屏" },
    "zh-CN": { compact: "紧凑" },
  },
};

test("shared field copy resolves each key without changing the catalog or configuration", () => {
  const node = {
    type: "string",
    enum: ["wide", "compact"],
    default: "",
    "x-ui": {
      labelKey: "label",
      descriptionKey: "help",
      enumKeys: ["wide", "compact"],
    },
  };
  const original = structuredClone({ catalog, node });
  assertMessageCatalog(catalog);
  assertFieldText(catalog, node);
  expect(fieldText(catalog, "zh-CN", node["x-ui"])).toEqual({
    label: "布局",
    description: "Choose layout",
    enumLabels: ["宽屏", "紧凑"],
  });
  expect(messageText(catalog, "fr-FR", "label")).toBe("Layout");
  expect(messageText(catalog, "zh-CN", "missing")).toBe("missing");
  expect(fieldText(catalog, "en-US")).toEqual({
    label: undefined,
    description: undefined,
    enumLabels: undefined,
  });
  expect({ catalog, node }).toEqual(original);
});

test("shared catalog and reference validation have no plugin or theme policy", () => {
  for (const messages of [
    {},
    { "en-US": { label: " " } },
    { "en-US": {}, zh: { label: "布局" } },
    { "en-US": {}, zh_CN: {} },
  ] as MessageCatalog["messages"][]) {
    expect(() =>
      assertMessageCatalog({ defaultLocale: "en-US", messages }),
    ).toThrow();
  }
  for (const node of [
    { "x-ui": { labelKey: "missing" } },
    { enum: ["one"], "x-ui": { enumKeys: ["wide", "compact"] } },
    { title: "Inline" },
  ])
    expect(() => assertFieldText(catalog, node)).toThrow();
  // Allowed controls are decided by the calling business module.
  expect(() =>
    assertFieldText(catalog, {
      type: "string",
      "x-ui": { labelKey: "label", widget: "password" },
    }),
  ).not.toThrow();
});

test("schema traversal covers nested items and conditional branches", () => {
  const leaf = () => ({ type: "string", "x-ui": { labelKey: "label" } });
  const schema = {
    type: "object",
    properties: { items: { type: "array", items: leaf() } },
    allOf: [{ if: leaf(), then: leaf(), else: leaf() }],
  };
  expect(schemaNodes(schema).filter((node) => node["x-ui"]).length).toBe(4);
});
