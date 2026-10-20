import { cloneJson, pointer, type Config, type UIHints } from "./config";
import {
  localizedText,
  localeCandidates,
  isCanonicalLocale,
} from "../plugin-sdk/localization";
import type { PluginLocalization } from "../plugin-sdk/config";
export type {
  SchemaContent,
  PluginContent,
  PluginLocalization,
} from "../plugin-sdk/config";
function object(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Content must be a JSON object");
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported content field");
}
function text(value: unknown) {
  if (typeof value !== "string") throw new Error("Content must be text");
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
export function assertPluginContent(
  resource: PluginLocalization,
  schema: Config,
  hints: UIHints,
  paramsSchema?: Config,
  requireName = false,
) {
  if (["name", "description", "translations"].some((key) => key in resource))
    throw new Error("Place plugin display text in content");
  if (!isCanonicalLocale(resource.defaultLocale))
    throw new Error("Use a canonical default locale");
  object(resource.content);
  if (!resource.content[resource.defaultLocale])
    throw new Error("Default language content required");
  if (requireName && !resource.content[resource.defaultLocale]?.name?.trim())
    throw new Error("Default language name required");
  const nodes = schemaNodes(schema),
    params = paramsSchema ? schemaNodes(paramsSchema) : undefined;
  // Authoring schemas contain data rules only. Rendered copies may carry display labels.
  for (const node of [...nodes.values(), ...(params?.values() ?? [])])
    if (["title", "description", "x-enumLabels"].some((key) => key in node))
      throw new Error("Move schema display text into content");
  const groups = new Set(Object.values(hints).map((hint) => hint.group));
  for (const [locale, entry] of Object.entries(resource.content)) {
    if (!isCanonicalLocale(locale))
      throw new Error("Use a canonical locale tag");
    object(entry);
    keys(entry, [
      "name",
      "description",
      "configSchema",
      "paramsSchema",
      "groups",
    ]);
    for (const key of ["name", "description"])
      if (key in entry) text(entry[key]);
    if (entry.groups !== undefined) {
      object(entry.groups);
      for (const [group, label] of Object.entries(entry.groups)) {
        if (!groups.has(group)) throw new Error("Unknown UI group");
        text(label);
      }
    }
    for (const key of ["configSchema", "paramsSchema"] as const) {
      if (entry[key] === undefined) continue;
      object(entry[key]);
      const available = key === "configSchema" ? nodes : params;
      if (!available) throw new Error("No query schema");
      for (const [path, patch] of Object.entries(entry[key])) {
        const node = available.get(path);
        if (!node) throw new Error("Unknown schema node");
        object(patch);
        keys(patch, ["title", "description", "enumLabels"]);
        for (const field of ["title", "description"])
          if (field in patch) text(patch[field]);
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
export type LocalizedPlugin<T> = T & { name: string; description: string };

/** Display-only copy; never persist translated labels or alter configuration values. */
export function localizePlugin<
  T extends PluginLocalization & {
    id?: string;
    configSchema?: Config;
    paramsSchema?: Config;
    uiHints?: UIHints;
  },
>(plugin: T, locale: string): LocalizedPlugin<T> {
  const result = cloneJson(plugin);
  const display = {
    ...result,
    name: localizedText(plugin, locale, (c) => c.name, plugin.id ?? ""),
    description: localizedText(plugin, locale, (c) => c.description),
  };
  for (const key of ["configSchema", "paramsSchema"] as const) {
    if (!display[key]) continue;
    for (const [path, node] of schemaNodes(display[key])) {
      for (const field of ["title", "description"] as const) {
        const value = localizedText(
          plugin,
          locale,
          (c) => c[key]?.[path]?.[field],
        );
        if (value) node[field] = value;
      }
      if (Array.isArray(node.enum)) {
        const translated = localeCandidates(locale, plugin.defaultLocale).some(
          (tag) => plugin.content[tag]?.[key]?.[path]?.enumLabels,
        );
        if (translated)
          node["x-enumLabels"] = node.enum.map((value, index) =>
            localizedText(
              plugin,
              locale,
              (c) => c[key]?.[path]?.enumLabels?.[index],
              String(value),
            ),
          );
      }
    }
  }
  for (const hint of Object.values(display.uiHints ?? {}))
    if (hint.group) {
      const group = hint.group;
      hint.group = localizedText(
        plugin,
        locale,
        (c) => c.groups?.[group],
        group,
      );
    }
  return display;
}
