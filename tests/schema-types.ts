// Compile-time regressions, checked by bun run typecheck; no runtime test is needed.
import type {
  ConfigSchema,
  FieldSchema,
  ParamsSchema,
  ParameterSchema,
  ParameterConstraint,
  SchemaConstraint,
} from "@picloom/plugin-sdk";
import type { Field, Constraint, Manifest } from "@picloom/theme-sdk";

function schemaDeclarations() {
  const config = {
    type: "object",
    properties: {
      width: { type: "integer", minimum: 1, default: 1280 },
      token: { type: "string", "x-sensitive": true },
    },
    if: { properties: { width: { minimum: 100 } }, required: ["width"] },
    then: { required: ["token"] },
  } satisfies ConfigSchema;
  const params = {
    type: "object",
    properties: {
      width: { type: "integer", anyOf: [{ const: 0 }, { minimum: 100 }] },
    },
  } satisfies ParamsSchema;
  const theme = {
    type: "string",
    "x-localized": true,
    default: { "en-US": "Welcome", "zh-CN": "欢迎" },
  } satisfies Field;

  // @ts-expect-error Type names are checked.
  const typo: FieldSchema = { type: "integre" };
  // @ts-expect-error Constraints use numeric values.
  const numeric: FieldSchema = { type: "integer", minimum: "1" };
  // @ts-expect-error Unknown keywords are rejected.
  const keyword: FieldSchema = { type: "string", minLenght: 1 };
  // @ts-expect-error Only supported formats are accepted.
  const format: FieldSchema = { type: "string", format: "url" };
  // @ts-expect-error Configuration roots are objects.
  const root: ConfigSchema = { type: "string" };
  // @ts-expect-error Configuration roots cannot be sensitive.
  const sensitiveRoot: ConfigSchema = { type: "object", "x-sensitive": true };
  // @ts-expect-error Request parameters cannot be arrays.
  const array: ParameterSchema = { type: "array", items: { type: "string" } };
  // @ts-expect-error Request parameters cannot be objects.
  const nested: ParameterSchema = { type: "object", properties: {} };
  // @ts-expect-error Request parameters are optional.
  const required: ParamsSchema = { type: "object", required: ["width"] };
  const conditional: ParamsSchema = {
    type: "object",
    // @ts-expect-error Request parameters have no cross-parameter conditions.
    if: { required: ["width"] },
  };
  // @ts-expect-error Defaults belong to static fields, including in nested branches.
  const branch: SchemaConstraint = { properties: { width: { default: 1280 } } };
  // @ts-expect-error A field with defaults cannot be reused as a constraint branch.
  const reused: SchemaConstraint = config.properties.width;
  const storedText = { type: "string" as const, "x-sensitive": true };
  // @ts-expect-error Reused fields cannot add sensitive storage to request parameters.
  const storedParameter: ParameterSchema = storedText;
  // @ts-expect-error Parameter branches cannot inherit storage extensions either.
  const storedCondition: ParameterConstraint = storedText;
  // @ts-expect-error Branches cannot change field storage.
  const storage: SchemaConstraint = { "x-sensitive": true };
  // @ts-expect-error Theme fields do not support sensitive storage.
  const secret: Field = { type: "string", "x-sensitive": true };
  // @ts-expect-error Theme branches cannot supply defaults.
  const themeBranch: Constraint = { default: "Welcome" };
  // @ts-expect-error Theme configuration roots must be objects.
  const themeRoot: NonNullable<Manifest["configSchema"]> = { type: "string" };
}
