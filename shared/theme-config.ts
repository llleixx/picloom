import type { Schema } from "./field-schema";
import type { Config } from "./config";
/** Theme storage is a language dictionary; constraints see one language at a time. */
export function languageValue(
  schema: Schema,
  value: unknown,
  lang: string,
): any {
  if (schema["x-localized"])
    return !!value && typeof value === "object" && !Array.isArray(value)
      ? (value as Config)[lang]
      : undefined;
  if (
    schema.type === "object" &&
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const child = schema.properties?.[key];
        const next = child ? languageValue(child, item, lang) : item;
        return next === undefined ? [] : [[key, next]];
      }),
    );
  }
  if (schema.type === "array" && Array.isArray(value))
    return value.map((item) => languageValue(schema.items!, item, lang));
  return value;
}
