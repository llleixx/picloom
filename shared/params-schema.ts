import { assertSchema } from "./config";
import type { Schema } from "./field-schema";
export function assertParamsSchema(schema: Schema) {
  assertSchema(schema, "", "params");
  if (
    schema.type !== "object" ||
    Object.keys(schema).some(
      (k) =>
        ![
          "$schema",
          "type",
          "properties",
          "additionalProperties",
          "x-ui",
        ].includes(k),
    )
  )
    throw new Error(
      "Parameter schema must describe optional scalar parameters",
    );
  for (const [name, rule] of Object.entries(schema.properties ?? {})) {
    if (
      !name ||
      !["string", "number", "integer", "boolean"].includes(String(rule.type))
    )
      throw new Error("Unsupported request parameter");
  }
}
