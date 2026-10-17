import { cloneJson, pointer, type Config, type UIHints } from "./config";

import type {
  SchemaTranslation,
  PluginTranslation,
  PluginTranslations,
} from "../plugin-sdk/config";
export type {
  SchemaTranslation,
  PluginTranslation,
  PluginTranslations,
} from "../plugin-sdk/config";

function object(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Translation must be a JSON object");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported translation field");
}
function text(value: unknown) {
  if (typeof value !== "string") throw new Error("Translation must be text");
}
function schemaNodes(schema: Config): Map<string, Config> {
  const nodes = new Map<string, Config>();
  function visit(node: Config, path: string) {
    nodes.set(path, node);
    for (const [key, child] of Object.entries(
      (node.properties ?? {}) as Record<string, Config>,
    ))
      visit(child, `${path}/properties/${pointer(key)}`);
    for (const key of ["items", "if", "then", "else"])
      if (node[key]) visit(node[key] as Config, `${path}/${key}`);
    (node.allOf as Config[] | undefined)?.forEach((child, index) =>
      visit(child, `${path}/allOf/${index}`),
    );
  }
  visit(schema, "");
  return nodes;
}
export function assertTranslations(
  value: unknown,
  schema: Config,
  hints: UIHints,
  paramsSchema?: Config,
): asserts value is PluginTranslations {
  object(value);
  const nodes = schemaNodes(schema);
  const groups = new Set(Object.values(hints).map((hint) => hint.group));
  for (const [locale, translation] of Object.entries(value)) {
    // Canonical BCP 47 tags make lookups deterministic (zh-CN, not zh-cn).
    if (Intl.getCanonicalLocales(locale)[0] !== locale)
      throw new Error("Use a canonical locale tag");
    object(translation);
    keys(translation, [
      "name",
      "description",
      "configSchema",
      "paramsSchema",
      "groups",
    ]);
    for (const key of ["name", "description"])
      if (key in translation) text(translation[key]);
    if (translation.groups !== undefined) {
      object(translation.groups);
      for (const [group, label] of Object.entries(translation.groups)) {
        if (!groups.has(group)) throw new Error("Unknown UI group");
        text(label);
      }
    }
    if (translation.paramsSchema !== undefined) {
      if (!paramsSchema) throw new Error("No query schema");
      assertTranslations(
        { [locale]: { configSchema: translation.paramsSchema } },
        paramsSchema,
        {},
      );
    }
    if (translation.configSchema !== undefined) {
      object(translation.configSchema);
      for (const [path, patch] of Object.entries(translation.configSchema)) {
        const node = nodes.get(path);
        if (!node) throw new Error("Unknown schema node");
        object(patch);
        keys(patch, ["title", "description", "enumLabels"]);
        for (const key of ["title", "description"])
          if (key in patch) text(patch[key]);
        if (patch.enumLabels !== undefined) {
          if (
            !Array.isArray(node.enum) ||
            !Array.isArray(patch.enumLabels) ||
            patch.enumLabels.length !== node.enum.length
          )
            throw new Error("Enum labels must match enum values");
          patch.enumLabels.forEach(text);
        }
      }
    }
  }
}

/** Display-only copy. Never use the result as a persisted plugin definition. */
export function localizePlugin<
  T extends {
    name: string;
    description?: string;
    translations?: PluginTranslations;
    configSchema?: Config;
    paramsSchema?: Config;
    uiHints?: UIHints;
  },
>(plugin: T, locale: string): T {
  const result = cloneJson(plugin);
  const tag = Intl.getCanonicalLocales(locale)[0]!;
  const nodes = result.configSchema
    ? schemaNodes(result.configSchema)
    : undefined;
  const queryNodes = result.paramsSchema
    ? schemaNodes(result.paramsSchema)
    : undefined;
  const originalGroups = Object.fromEntries(
    Object.entries(result.uiHints ?? {}).map(([path, hint]) => [
      path,
      hint.group,
    ]),
  );
  // Apply base language first; exact locale overrides individual supplied fields.
  for (const language of new Set([tag.split("-")[0]!, tag])) {
    const translation = plugin.translations?.[language];
    if (!translation) continue;
    if (translation.name !== undefined) result.name = translation.name;
    if (translation.description !== undefined)
      result.description = translation.description;
    for (const [path, patch] of Object.entries(
      translation.configSchema ?? {},
    )) {
      const node = nodes?.get(path);
      if (!node) continue; // Summary responses have no schema.
      if (patch.title !== undefined) node.title = patch.title;
      if (patch.description !== undefined) node.description = patch.description;
      if (patch.enumLabels !== undefined)
        node["x-enumLabels"] = [...patch.enumLabels];
    }
    for (const [path, patch] of Object.entries(
      translation.paramsSchema ?? {},
    )) {
      const node = queryNodes?.get(path);
      if (!node) continue; // Summary responses have no schema.
      if (patch.title !== undefined) node.title = patch.title;
      if (patch.description !== undefined) node.description = patch.description;
      if (patch.enumLabels !== undefined)
        node["x-enumLabels"] = [...patch.enumLabels];
    }
    for (const [path, group] of Object.entries(originalGroups)) {
      const label =
        group === undefined ? undefined : translation.groups?.[group];
      if (label !== undefined) result.uiHints![path]!.group = label;
    }
  }
  return result;
}
