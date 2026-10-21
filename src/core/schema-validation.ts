import Ajv2020, {
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { DeclarationError, pointer } from "../../shared/config";
import type { Schema } from "../../shared/field-schema";
import { schemaEntries } from "../../shared/package-localization";

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  strictNumbers: true,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
  ownProperties: true,
});
addFormats(ajv);
function decimalParts(value: number): [bigint, number] {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  return [
    BigInt(coefficient!.replace(".", "")),
    Number(exponent) - (coefficient!.split(".")[1]?.length ?? 0),
  ];
}
// Check JSON decimal values exactly, without binary division or a tolerance.
ajv.removeKeyword("multipleOf");
ajv.addKeyword({
  keyword: "multipleOf",
  type: "number",
  schemaType: "number",
  validate: (step: number, value: number) => {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
      return false;
    const [dividend, valueExponent] = decimalParts(value);
    const [divisor, stepExponent] = decimalParts(step);
    const exponent = valueExponent - stepExponent;
    return exponent >= 0
      ? (dividend * 10n ** BigInt(exponent)) % divisor === 0n
      : dividend % (divisor * 10n ** BigInt(-exponent)) === 0n;
  },
});
for (const keyword of ["x-sensitive", "x-immutable", "x-localized"])
  ajv.addKeyword({ keyword, schemaType: "boolean", valid: true });
ajv.addKeyword({ keyword: "x-ui", schemaType: "object", valid: true });
const compiled = new WeakMap<Schema, ValidateFunction>();
export function schemaErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((e) => ({
    path:
      e.instancePath +
      (e.keyword === "required"
        ? "/" + pointer(e.params.missingProperty)
        : e.keyword === "additionalProperties"
          ? "/" + pointer(e.params.additionalProperty)
          : ""),
    message: e.message ?? "Invalid field",
  }));
}
/** Only static nodes gain storage/value bounds. Constraints keep their boolean semantics. */
export function valueSchema(
  schema: Schema,
  mode: "complete" | "draft" | "default" = "complete",
): Schema {
  const result = { ...schema };
  if (
    mode === "draft" ||
    (mode === "default" && ["object", "array"].includes(String(schema.type)))
  )
    for (const key of [
      "required",
      "if",
      "then",
      "else",
      "allOf",
      "anyOf",
      "oneOf",
      "not",
    ] as const)
      delete result[key];
  if (mode === "draft")
    for (const key of ["minItems", "maxItems", "uniqueItems"] as const)
      delete result[key];
  if (schema.type === "integer") {
    result.minimum = Math.max(
      Number(schema.minimum ?? -Number.MAX_SAFE_INTEGER),
      -Number.MAX_SAFE_INTEGER,
    );
    result.maximum = Math.min(
      Number(schema.maximum ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (schema.type === "object") {
    result.additionalProperties ??= false;
    result.properties = Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([key, child]) => [
        key,
        valueSchema(child, mode),
      ]),
    );
  }
  if (schema.items) result.items = valueSchema(schema.items, mode);
  return result;
}
export function compileSchema(schema: Schema): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    const rule = valueSchema(schema);
    validate = ajv.compile(rule);
    ajv.removeSchema(rule);
    compiled.set(schema, validate);
  }
  return validate;
}
export function assertDeclaration(schema: Schema, path: string) {
  if (!ajv.validateSchema(schema)) {
    const issue = ajv.errors?.[0];
    throw new DeclarationError(
      `${path}${issue?.instancePath ?? ""}: Invalid ${issue?.keyword ?? "schema"} declaration`,
    );
  }
  try {
    compileSchema(schema);
  } catch {
    throw new DeclarationError(
      `${path}: Schema constraints cannot be compiled`,
    );
  }
  for (const entry of schemaEntries(schema, false)) {
    const node = entry.node as Schema;
    const check = (value: unknown, rule: Schema, label: string) => {
      if (!compileSchema(rule)(value))
        throw new DeclarationError(
          `${path}${entry.path}: ${label} does not satisfy field constraints`,
        );
    };
    if (node.default !== undefined)
      check(node.default, valueSchema(node, "default"), "Default");
    if (Array.isArray(node.enum))
      for (const value of node.enum) {
        const rule = { ...node };
        delete rule.enum;
        check(value, rule, "Enum option");
      }
  }
}
