import { initialValue } from "@picloom/package-rules";
export { initialValue } from "@picloom/package-rules";
import type { Json, Config } from "@picloom/plugin-sdk";
import type { FieldSchema } from "@picloom/plugin-sdk";
/** Host representation for static fields and constraint branches in either SDK. */
export interface Schema extends Omit<
  Partial<FieldSchema>,
  | "properties"
  | "items"
  | "allOf"
  | "anyOf"
  | "oneOf"
  | "not"
  | "if"
  | "then"
  | "else"
  | "x-localized"
> {
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  if?: Schema;
  then?: Schema;
  else?: Schema;
  "x-localized"?: boolean;
}
/** Omission declares no custom fields; only undefined is treated as omission. */
export function schemaOrEmpty<T>(schema: T | undefined) {
  return schema === undefined
    ? {
        type: "object" as const,
        properties: {},
        additionalProperties: false as const,
      }
    : schema;
}
/** JSON object member order is not part of value equality. */
export function equalJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, index) => equalJson(value, b[index]))
    );
  const left = a as Config,
    right = b as Config;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]),
    )
  );
}
export function readPointer(value: Config, path: string): Json | undefined {
  if (path === "") return value;
  let current: any = value;
  for (const token of path.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object") return undefined;
    // Read absent members too so reactive callers track later additions.
    const child = current[key];
    if (!Object.hasOwn(current, key)) return undefined;
    current = child;
  }
  return current;
}
export function writePointer(
  value: Config,
  path: string,
  item: Json | undefined,
) {
  const keys = path
    .slice(1)
    .split("/")
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.some((k) => ["__proto__", "constructor", "prototype"].includes(k)))
    throw new Error("Unsafe field");
  let current: any = value;
  for (const key of keys.slice(0, -1)) {
    if (
      !Object.hasOwn(current, key) ||
      !current[key] ||
      typeof current[key] !== "object"
    ) {
      if (item === undefined) return;
      current[key] = {};
    }
    current = current[key];
  }
  if (item === undefined) delete current[keys.at(-1)!];
  else current[keys.at(-1)!] = item;
}
const keywords = new Set([
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "x-localized",
  "x-sensitive",
  "x-immutable",
  "x-ui",
]);
export class DeclarationError extends Error {}

function containsSensitiveValue(
  schema: Schema,
  value: Json | undefined,
): boolean {
  if (value === undefined) return false;
  if (schema["x-sensitive"] === true) return true;
  if (schema.type === "array" && Array.isArray(value))
    return sensitivePaths(schema).length > 0;
  if (value && typeof value === "object" && !Array.isArray(value))
    return Object.entries(schema.properties ?? {}).some(
      ([key, child]) =>
        Object.hasOwn(value, key) && containsSensitiveValue(child, value[key]),
    );
  return false;
}
export function assertSchema(
  schema: unknown,
  path = "",
  scenario: "plugin" | "theme" | "params" = "plugin",
) {
  try {
    assertSerializable(schema);
  } catch (error) {
    throw new DeclarationError(
      `${path || "/"}: ${error instanceof Error ? error.message : "Invalid schema"}`,
    );
  }
  const rule = schema as Schema;
  assertSchemaNode(rule, path, rule, false, false);
  function scene(node: Schema) {
    if (
      scenario !== "plugin" &&
      ("x-sensitive" in node || "x-immutable" in node)
    )
      throw new DeclarationError(
        `${path || "/"}: Unsupported storage extension`,
      );
    if (
      "x-localized" in node &&
      (scenario !== "theme" ||
        typeof node["x-localized"] !== "boolean" ||
        (node["x-localized"] && node.type !== "string"))
    )
      throw new DeclarationError(
        `${path || "/"}: Only theme text can be localized`,
      );
    for (const child of Object.values(node.properties ?? {})) scene(child);
    if (node.items) scene(node.items);
  }
  scene(rule);
}
function assertSchemaNode(
  schema: Schema,
  path: string,
  structure: Schema,
  constraint: boolean,
  inItems: boolean,
) {
  try {
    validateSchemaNode(schema, path, structure, constraint, inItems);
  } catch (error) {
    if (error instanceof DeclarationError) throw error;
    throw new DeclarationError(
      `${path || "/"}: ${error instanceof Error ? error.message : "Invalid schema"}`,
    );
  }
}
function validateSchemaNode(
  schema: Schema,
  path: string,
  structure: Schema,
  constraint: boolean,
  inItems: boolean,
) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("Expected schema object");
  if (
    constraint &&
    Object.keys(schema).some((key) => key === "default" || key.startsWith("x-"))
  )
    throw new Error("Constraints cannot declare defaults or field extensions");
  if (inItems && "x-immutable" in schema)
    throw new Error("Declare immutability on the containing array");
  if (containsSensitiveValue(structure, schema.default))
    throw new Error("Sensitive fields cannot have defaults");
  for (const key of Object.keys(schema))
    if (!keywords.has(key))
      throw new Error(`Unsupported schema keyword: ${key}`);
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" ||
      ![
        "object",
        "array",
        "string",
        "number",
        "integer",
        "boolean",
        "null",
      ].includes(schema.type))
  )
    throw new Error("Unsupported schema type");
  if (!constraint && !schema.type)
    throw new Error("Static fields require a type");
  const type = schema.type ?? structure.type;
  for (const [keys, types] of [
    [["properties", "required", "additionalProperties"], ["object"]],
    [["items", "minItems", "maxItems", "uniqueItems"], ["array"]],
    [
      [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
      ],
      ["number", "integer"],
    ],
    [["minLength", "maxLength", "pattern", "format"], ["string"]],
  ])
    if (
      keys!.some((key) => key in schema) &&
      !(types as readonly string[]).includes(String(type))
    )
      throw new Error("Constraint does not match field type");
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const)
    if (
      typeof schema[min!] === "number" &&
      typeof schema[max!] === "number" &&
      schema[min!]! > schema[max!]!
    )
      throw new Error("Invalid constraint range");
  if (
    schema.required &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        (key) =>
          typeof key !== "string" ||
          !Object.hasOwn(structure.properties ?? {}, key),
      ))
  )
    throw new Error("Undeclared required field");
  if (
    !constraint &&
    schema.type === "array" &&
    (!schema.items ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items))
  )
    throw new Error("Arrays require one item schema");
  if (
    schema.format &&
    ![
      "date",
      "time",
      "date-time",
      "duration",
      "email",
      "hostname",
      "ipv4",
      "ipv6",
      "uri",
      "uri-reference",
      "uuid",
      "regex",
    ].includes(String(schema.format))
  )
    throw new Error("Unsupported format");
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  )
    throw new Error("Open object schemas are not supported");
  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("Unsafe field");
    const fields = structure.properties ?? {};
    const target = fields[key];
    if (constraint && !Object.hasOwn(fields, key))
      throw new DeclarationError(
        `${path}/properties/${pointer(key)}: Constraint cannot introduce fields`,
      );
    assertSchemaNode(
      rule,
      path + "/properties/" + pointer(key),
      constraint ? target! : rule,
      constraint,
      inItems,
    );
  }
  if (schema.items) {
    if (constraint && !structure.items)
      throw new Error("Constraint cannot introduce array items");
    assertSchemaNode(
      schema.items!,
      path + "/items",
      (constraint ? structure.items : schema.items)!,
      constraint,
      true,
    );
  }
  for (const key of ["if", "then", "else", "not"] as const)
    if (schema[key])
      assertSchemaNode(
        schema[key]!,
        path + "/" + key,
        structure,
        true,
        inItems,
      );
  for (const key of ["allOf", "anyOf", "oneOf"] as const)
    for (const [index, item] of (schema[key] ?? []).entries())
      assertSchemaNode(
        item,
        path + "/" + key + "/" + index,
        structure,
        true,
        inItems,
      );
}
function assertSerializable(value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === undefined
  )
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON value");
    return;
  }
  if (
    typeof value !== "object" ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Description must be JSON data");
  for (const child of Object.values(value)) assertSerializable(child);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function pointer(key: string) {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
export function sensitivePaths(schema: Schema, path = ""): string[] {
  if (
    schema["x-sensitive"] === true ||
    (schema.type === "array" &&
      schema.items &&
      sensitivePaths(schema.items!).length > 0)
  )
    return [path];
  return Object.entries(schema.properties ?? {}).flatMap(([key, rule]) =>
    sensitivePaths(rule, path + "/" + pointer(key)),
  );
}

export function initialConfig(schema: Schema): Config {
  return (initialValue(schema) ?? {}) as Config;
}
