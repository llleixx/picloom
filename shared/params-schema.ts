import { assertSchema, type Config } from "./config";
export function assertParamsSchema(schema: Config) {
  assertSchema(schema);
  if (
    schema.type !== "object" ||
    Object.keys(schema).some(
      (k) =>
        ![
          "type",
          "properties",
          "additionalProperties",
          "title",
          "description",
        ].includes(k),
    )
  )
    throw new Error(
      "Parameter schema must describe optional scalar parameters",
    );
  for (const [name, rule] of Object.entries(
    (schema.properties ?? {}) as Record<string, Config>,
  )) {
    if (
      !name ||
      !["string", "number", "integer", "boolean"].includes(String(rule.type)) ||
      Object.keys(rule).some(
        (k) =>
          ![
            "type",
            "title",
            "description",
            "enum",
            "x-enumLabels",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "multipleOf",
            "minLength",
            "maxLength",
            "pattern",
            "format",
          ].includes(k),
      )
    )
      throw new Error("Unsupported request parameter");
  }
}
