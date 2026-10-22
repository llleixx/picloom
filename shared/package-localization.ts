import { messageText, type MessageCatalog } from "@picloom/package-rules";
export { messageText, type MessageCatalog } from "@picloom/package-rules";
export interface FieldTextHints {
  labelKey?: string;
  descriptionKey?: string;
  enumKeys?: string[];
}
/** Locale codes are canonical BCP 47 tags. Each resource owns its fallback. */
export function isCanonicalLocale(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}
export function assertObject(v: unknown): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype
  )
    throw new Error("Expected a JSON object");
}
export function schemaEntries(
  schema: SchemaNode,
  constraints = true,
): Array<{ node: SchemaNode; path: string }> {
  const entries: Array<{ node: SchemaNode; path: string }> = [];
  function visit(node: SchemaNode, path: string) {
    entries.push({ node, path });
    for (const [key, child] of Object.entries(node.properties ?? {}))
      visit(
        child,
        path + "/properties/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
      );
    for (const key of constraints
      ? (["items", "if", "then", "else", "not"] as const)
      : (["items"] as const))
      if (node[key]) visit(node[key], path + "/" + key);
    for (const key of constraints ? (["allOf", "anyOf", "oneOf"] as const) : [])
      for (const [index, child] of (node[key] ?? []).entries())
        visit(child, path + "/" + key + "/" + index);
  }
  visit(schema, "");
  return entries;
}
export function schemaNodes(schema: SchemaNode): SchemaNode[] {
  return schemaEntries(schema).map((entry) => entry.node);
}

// Only structure shared by the two supported schema subsets is traversed here.
export interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  if?: SchemaNode;
  then?: SchemaNode;
  else?: SchemaNode;
  not?: SchemaNode;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  enum?: unknown[];
  "x-ui"?: unknown;
}
export function assertMessageCatalog(resource: MessageCatalog) {
  if (!isCanonicalLocale(resource.defaultLocale))
    throw new Error("Invalid default locale");
  assertObject(resource.messages);
  const defaults = resource.messages[resource.defaultLocale];
  assertObject(defaults);
  for (const [locale, dictionary] of Object.entries(resource.messages)) {
    if (!isCanonicalLocale(locale)) throw new Error("Invalid locale");
    assertObject(dictionary);
    for (const [key, value] of Object.entries(dictionary)) {
      if (!key.trim() || typeof value !== "string" || !value.trim())
        throw new Error("Invalid message");
      if (!Object.hasOwn(defaults, key))
        throw new Error("Default catalog must contain every message key");
    }
  }
}
export function assertMessageKey(resource: MessageCatalog, value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !Object.hasOwn(resource.messages[resource.defaultLocale]!, value)
  )
    throw new Error("Unknown message key");
}
export function assertFieldText(resource: MessageCatalog, node: SchemaNode) {
  if (
    ["title", "description", "content", "x-enumLabels", "x-multiline"].some(
      (k) => k in node,
    )
  )
    throw new Error("Use x-ui message keys");
  const ui = node["x-ui"];
  if (ui === undefined) return;
  assertObject(ui);
  for (const key of ["labelKey", "descriptionKey"])
    if (ui[key] !== undefined) assertMessageKey(resource, ui[key]);
  if (ui.enumKeys !== undefined) {
    if (
      !Array.isArray(node.enum) ||
      !Array.isArray(ui.enumKeys) ||
      ui.enumKeys.length !== node.enum.length
    )
      throw new Error("Enum keys must match enum values");
    ui.enumKeys.forEach((key) => assertMessageKey(resource, key));
  }
  return ui;
}
export function fieldText(
  resource: MessageCatalog,
  locale: string,
  hints: FieldTextHints = {},
) {
  return {
    label: hints.labelKey
      ? messageText(resource, locale, hints.labelKey)
      : undefined,
    description: hints.descriptionKey
      ? messageText(resource, locale, hints.descriptionKey)
      : undefined,
    enumLabels: hints.enumKeys?.map((key) =>
      messageText(resource, locale, key),
    ),
  };
}

export function assertFieldHints(resource: MessageCatalog, node: SchemaNode) {
  const ui = assertFieldText(resource, node);
  if (ui === undefined) return;
  if (
    Object.keys(ui).some(
      (k) =>
        ![
          "labelKey",
          "descriptionKey",
          "enumKeys",
          "widget",
          "groupKey",
          "order",
          "advanced",
          "visibleWhen",
        ].includes(k),
    )
  )
    throw new Error("Unsupported UI hint");
  if (ui.groupKey !== undefined) assertMessageKey(resource, ui.groupKey);
  if (
    ui.widget !== undefined &&
    (typeof ui.widget !== "string" ||
      !["textarea", "password"].includes(ui.widget) ||
      node.type !== "string")
  )
    throw new Error("Invalid widget");
  if (
    ui.order !== undefined &&
    (typeof ui.order !== "number" || !Number.isFinite(ui.order))
  )
    throw new Error("Invalid order");
  if (ui.advanced !== undefined && typeof ui.advanced !== "boolean")
    throw new Error("Invalid advanced flag");
  if (ui.visibleWhen !== undefined) {
    assertObject(ui.visibleWhen);
    if (
      typeof ui.visibleWhen.path !== "string" ||
      !ui.visibleWhen.path.startsWith("/") ||
      ui.visibleWhen.equals === undefined ||
      Object.keys(ui.visibleWhen).some((k) => !["path", "equals"].includes(k))
    )
      throw new Error("Invalid visibility condition");
  }
}
