import { isLocale } from "../../shared/locales";
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
export function validateField(f: unknown, depth = 0): asserts f is Field {
  if (
    !object(f) ||
    depth > 8 ||
    !["object", "string", "number", "integer", "boolean"].includes(f.type)
  )
    throw invalid("Unsupported theme configuration schema");
  const keys = [
    "type",
    "title",
    "description",
    "properties",
    "required",
    "enum",
    "default",
    "minimum",
    "maximum",
    "maxLength",
    "minLength",
    "x-multiline",
    "x-localized",
    "content",
  ];
  if (Object.keys(f).some((k) => !keys.includes(k)))
    throw invalid("Unsupported schema keyword");
  if (f["x-localized"] && f.type !== "string")
    throw invalid("Only text can be localized");
  for (const key of ["title", "description"])
    if (f[key] !== undefined && typeof f[key] !== "string") throw invalid();
  for (const key of ["minimum", "maximum", "maxLength", "minLength"])
    if (
      f[key] !== undefined &&
      (typeof f[key] !== "number" || !Number.isFinite(f[key]))
    )
      throw invalid();
  for (const key of ["minLength", "maxLength"])
    if (
      f[key] !== undefined &&
      (f.type !== "string" || !Number.isSafeInteger(f[key]) || f[key] < 0)
    )
      throw invalid("Invalid text length constraint");
  if (
    f.minLength !== undefined &&
    f.maxLength !== undefined &&
    f.minLength > f.maxLength
  )
    throw invalid("Invalid text length range");
  if (
    f.enum !== undefined &&
    (!Array.isArray(f.enum) ||
      !f.enum.length ||
      f.enum.some(
        (v: unknown) => !["string", "number", "boolean"].includes(typeof v),
      ))
  )
    throw invalid();
  if (f.content !== undefined) {
    if (!object(f.content)) throw invalid();
    for (const [locale, content] of Object.entries(f.content)) {
      if (!isLocale(locale) || !object(content)) throw invalid();
      for (const [key, value] of Object.entries(content)) {
        if (key === "enumLabels") {
          if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
            throw invalid();
        } else if (
          !["title", "description"].includes(key) ||
          typeof value !== "string"
        )
          throw invalid();
      }
    }
  }
  if (f.type === "object") {
    if (!object(f.properties)) throw invalid();
    for (const [key, child] of Object.entries(f.properties)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) ||
        ["constructor", "prototype", "__proto__"].includes(key)
      )
        throw invalid();
      validateField(child, depth + 1);
    }
    if (
      f.required !== undefined &&
      (!Array.isArray(f.required) ||
        f.required.some(
          (k: unknown) =>
            typeof k !== "string" || !Object.hasOwn(f.properties, k),
        ))
    )
      throw invalid();
  }
}
export function configuration(
  schema: Field | undefined,
  input: unknown,
  initialize = false,
  complete = true,
  locales: readonly string[] = [],
): Config {
  const fieldError = (path: string) =>
    new AppError("INVALID_INPUT", "Invalid theme configuration", 400, [
      {
        path: "/" + path,
        message:
          "Required value is missing or does not meet the field constraints.",
      },
    ]);
  const visit = (
    f: Field,
    value: unknown,
    path: string,
    required = false,
  ): Json => {
    value =
      value === undefined && initialize ? structuredClone(f.default) : value;
    if (f["x-localized"]) {
      if (value === undefined) return {};
      if (!object(value) || Object.keys(value).some((k) => !isLocale(k)))
        throw fieldError(path);
      if (complete && required)
        for (const lang of locales)
          if (value[lang] === undefined) throw fieldError(path + "/" + lang);
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          visit(
            { ...f, "x-localized": false, default: undefined },
            v,
            path + "/" + k,
          ),
        ]),
      );
    }
    if (f.type === "object") {
      if (value === undefined) value = {};
      if (
        !object(value) ||
        Object.keys(value).some((k) => !Object.hasOwn(f.properties!, k))
      )
        throw fieldError(path);
      const result: Config = {};
      for (const [key, child] of Object.entries(f.properties!)) {
        const required = f.required?.includes(key) ?? false;
        const childValue =
          value[key] === undefined && initialize
            ? structuredClone(child.default)
            : value[key];
        if (
          childValue === undefined &&
          !(initialize && child.type === "object")
        ) {
          if (complete && required) throw fieldError(path + "/" + key);
          continue;
        }
        result[key] = visit(child, childValue, path + "/" + key, required);
      }
      return result;
    }
    if (
      f.type === "integer"
        ? !Number.isSafeInteger(value)
        : typeof value !== f.type
    )
      throw fieldError(path);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        (f.minimum !== undefined && value < f.minimum) ||
        (f.maximum !== undefined && value > f.maximum))
    )
      throw fieldError(path);
    if (
      typeof value === "string" &&
      ([...value].length > (f.maxLength ?? 10000) ||
        [...value].length < (f.minLength ?? 0))
    )
      throw fieldError(path);
    if (f.enum && !f.enum.includes(value as string)) throw fieldError(path);
    return value as Json;
  };
  return visit(
    schema ?? { type: "object", properties: {} },
    input,
    "config",
  ) as Config;
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
  {
    if (!object(input.content) || !input.content[input.defaultLocale])
      throw invalid("Default language name required");
    for (const [language, content] of Object.entries(input.content)) {
      if (
        !isLocale(language) ||
        !object(content) ||
        Object.keys(content).some((key) => key !== "name") ||
        typeof content.name !== "string" ||
        !content.name.trim() ||
        content.name.length > 100
      )
        throw invalid("Invalid localized theme name");
    }
  }
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
  if (input.configSchema !== undefined) {
    validateField(input.configSchema);
    if (input.configSchema.type !== "object") throw invalid();
  }
  if (!object(input.messages)) throw invalid("Theme dictionaries are required");
  const dictionaries = input.messages;
  const keys = new Set<string>();
  for (const entries of Object.values(dictionaries)) {
    if (
      !object(entries) ||
      Object.values(entries).some((v) => typeof v !== "string" || !v.trim())
    )
      throw invalid("Invalid translation");
    Object.keys(entries).forEach((key) => keys.add(key));
  }
  if (
    Object.keys(dictionaries).some(
      (lang) => !input.supportedLocales.includes(lang),
    ) ||
    !object(dictionaries[input.defaultLocale]) ||
    [...keys].some(
      (key) => !Object.hasOwn(dictionaries[input.defaultLocale], key),
    )
  )
    throw invalid(
      "Default language dictionary must contain every translation key",
    );
  configuration(input.configSchema, {}, true, false);
  return structuredClone(input) as Manifest;
}
