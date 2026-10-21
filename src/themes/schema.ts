import { languageValue as project } from "../../shared/theme-config";
import { schemaOrEmpty, type Schema } from "../../shared/field-schema";
import { assertSchema, initialValue, pointer } from "../../shared/config";
import {
  assertDeclaration,
  compileSchema,
  valueSchema,
  schemaErrors,
} from "../core/schema-validation";
import {
  assertMessageCatalog,
  assertMessageKey,
  assertFieldHints,
  schemaNodes,
  schemaEntries,
} from "../../shared/package-localization";
import { isLocale, supportedLocales } from "../../shared/locales";
import type { Config, Field, Json, Manifest } from "../../theme-sdk";
import { AppError } from "../core/errors";
export const invalid = (message = "Invalid theme package or configuration") =>
  new AppError("INVALID_INPUT", message);
export const safeName = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(v) &&
  !v.endsWith(".");
export const assetPath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 240 &&
  !/[\\:< >"|?*\x00-\x1f]/.test(v) &&
  v.split("/").every((p) => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p));
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function projectedSchema(
  schema: Schema,
  lang: string,
  structure = schema,
  constraint = false,
): Schema {
  const result = { ...schema };
  delete result.default;
  delete result["x-localized"];
  if (!constraint && schema.type === "string") result.maxLength ??= 10000;
  for (const key of ["const", "enum"] as const)
    if (schema[key] !== undefined && !structure["x-localized"]) {
      result[key] =
        key === "enum"
          ? (schema.enum as Json[]).map((value) =>
              project(structure, value, lang),
            )
          : project(structure, schema.const, lang);
    }
  if (schema.properties)
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        projectedSchema(
          child,
          lang,
          (structure.properties ?? {})[key] ?? child,
          constraint,
        ),
      ]),
    );
  if (schema.items)
    result.items = projectedSchema(
      schema.items!,
      lang,
      structure.items!,
      constraint,
    );
  for (const key of ["if", "then", "else", "not"] as const)
    if (schema[key])
      result[key] = projectedSchema(schema[key]!, lang, structure, true);
  for (const key of ["allOf", "anyOf", "oneOf"] as const)
    if (schema[key])
      result[key] = schema[key]!.map((child) =>
        projectedSchema(child, lang, structure, true),
      );
  return result;
}
const validators = new WeakMap<
  Schema,
  Map<string, ReturnType<typeof compileSchema>>
>();
function themeValidator(
  schema: Schema,
  lang: string,
  mode: "complete" | "draft" | "default",
) {
  let entries = validators.get(schema);
  if (!entries) {
    entries = new Map();
    validators.set(schema, entries);
  }
  const key = lang + "/" + mode;
  let validate = entries.get(key);
  if (!validate) {
    const projected = projectedSchema(schema, lang);
    validate = compileSchema(valueSchema(projected, mode));
    entries.set(key, validate);
  }
  return validate;
}
function storageLanguages(
  schema: Schema,
  value: unknown,
  path: string,
  languages: Set<string>,
) {
  if (value === undefined) return;
  if (schema["x-localized"]) {
    if (!object(value) || Object.keys(value).some((key) => !isLocale(key)))
      throw fieldError(path);
    for (const lang of Object.keys(value)) languages.add(lang);
    return;
  }
  if (schema.type === "object" && object(value))
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (Object.hasOwn(value, key))
        storageLanguages(
          child,
          value[key],
          path + "/" + pointer(key),
          languages,
        );
  if (schema.type === "array" && Array.isArray(value))
    value.forEach((item, index) =>
      storageLanguages(schema.items!, item, path + "/" + index, languages),
    );
}
function languagePath(schema: Schema, path: string, lang: string) {
  let node = schema;
  let result = "";
  for (const token of path.split("/").slice(1)) {
    result += "/" + token;
    const child =
      node.type === "array"
        ? node.items
        : node.properties?.[token.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (!child) break;
    node = child;
    if (node["x-localized"]) return result + "/" + pointer(lang);
  }
  return result;
}
const fieldError = (path: string) =>
  new AppError("INVALID_INPUT", "Invalid theme configuration", 400, [
    { path, message: "Value does not meet the field constraints." },
  ]);
export function validateField(
  f: unknown,
  path = "/configSchema",
): asserts f is Field {
  try {
    assertSchema(f as Schema, path, "theme");
    for (const { node: entry, path: relativePath } of schemaEntries(
      f as Schema,
      false,
    )) {
      const node = entry as Schema;
      const location = path + relativePath;
      if (node.default !== undefined) {
        const languages = new Set<string>();
        storageLanguages(node, node.default, location, languages);
        if (!languages.size) languages.add("en-US");
        for (const lang of languages)
          if (
            !themeValidator(
              node,
              lang,
              "default",
            )(project(node, node.default, lang))
          )
            throw new Error(
              `${location}: Default does not satisfy field constraints`,
            );
      }
    }
    // Declaration checking and enum validation use the same value engine.
    for (const lang of supportedLocales)
      assertDeclaration(projectedSchema(f as Schema, lang), path);
  } catch (error) {
    throw invalid(
      `${path}: ${error instanceof Error ? error.message : "Invalid field declaration"}`,
    );
  }
}
export function configuration(
  schema: Field | undefined,
  input: unknown,
  initialize = false,
  complete = true,
  locales: readonly string[] = [],
): Config {
  const rule = schemaOrEmpty(schema);
  const value = initialize
    ? (initialValue(rule, input as Json) ??
      (rule.type === "object" ? {} : undefined))
    : input;
  const languages = new Set(locales);
  storageLanguages(rule, value, "/config", languages);
  if (!languages.size) languages.add("en-US");
  for (const lang of languages) {
    const validate = themeValidator(
      rule,
      lang,
      complete ? "complete" : "draft",
    );
    if (!validate(project(rule, value, lang)))
      throw new AppError(
        "INVALID_INPUT",
        "Invalid theme configuration",
        400,
        schemaErrors(validate.errors).map((error) => ({
          ...error,
          path: "/config" + languagePath(rule, error.path, lang),
        })),
      );
  }
  return structuredClone(value) as Config;
}

export function manifest(input: unknown): Manifest {
  if (
    !object(input) ||
    !safeName(input.id) ||
    input.id.startsWith("builtin.") ||
    !safeName(input.version) ||
    "name" in input ||
    input.apiVersion !== 1 ||
    !isLocale(input.defaultLocale) ||
    !Array.isArray(input.supportedLocales) ||
    !input.supportedLocales.length ||
    !input.supportedLocales.every(isLocale) ||
    new Set(input.supportedLocales).size !== input.supportedLocales.length ||
    !input.supportedLocales.includes(input.defaultLocale) ||
    !object(input.pages)
  )
    throw invalid();
  if (
    !Object.keys(input.pages).length ||
    Object.keys(input.pages).some((k) => !["home", "login"].includes(k))
  )
    throw invalid();
  const styles = (v: unknown) => {
    if (
      v !== undefined &&
      (!Array.isArray(v) || v.some((p) => !assetPath(p) || !p.endsWith(".css")))
    )
      throw invalid();
  };
  styles(input.styles);
  for (const page of Object.values(input.pages)) {
    if (!object(page) || !assetPath(page.entry) || !/\.m?js$/.test(page.entry))
      throw invalid();
    styles(page.styles);
  }
  if (
    input.preview !== undefined &&
    (!assetPath(input.preview) || !/\.(png|jpe?g|webp)$/i.test(input.preview))
  )
    throw invalid();
  const configSchema = schemaOrEmpty(input.configSchema);
  validateField(configSchema);
  if (configSchema.type !== "object") throw invalid();
  try {
    if (
      [
        "name",
        "description",
        "descriptionKey",
        "content",
        "translations",
        "uiHints",
      ].some((k) => k in input)
    )
      throw invalid("Unsupported theme metadata");
    assertMessageCatalog(input as Manifest);
    assertMessageKey(input as Manifest, input.nameKey);
    for (const node of schemaNodes(configSchema)) {
      assertFieldHints(input as Manifest, node);
    }
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : "Invalid theme messages");
  }
  if (
    Object.keys(input.messages).some(
      (lang) => !input.supportedLocales.includes(lang),
    )
  )
    throw invalid("Unsupported message language");
  configuration(configSchema, undefined, true, false);
  return structuredClone({ ...input, configSchema }) as Manifest;
}
