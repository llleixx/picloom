import type { FieldHint, Json } from "./config";

export type SchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";
export type SchemaFormat =
  | "date"
  | "time"
  | "date-time"
  | "duration"
  | "email"
  | "hostname"
  | "ipv4"
  | "ipv6"
  | "uri"
  | "uri-reference"
  | "uuid"
  | "regex";

interface Composition<T> {
  allOf?: T[];
  anyOf?: T[];
  oneOf?: T[];
  not?: T;
  if?: T;
  then?: T;
  else?: T;
}
interface ScalarConstraints {
  enum?: Json[];
  const?: Json;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: SchemaFormat;
}
/** Branches constrain existing fields; defaults and extensions belong to static fields. */
export interface SchemaConstraint
  extends ScalarConstraints, Composition<SchemaConstraint> {
  $schema?: string;
  type?: SchemaType;
  properties?: Record<string, SchemaConstraint>;
  items?: SchemaConstraint;
  required?: string[];
  additionalProperties?: false;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: never;
  "x-ui"?: never;
  "x-sensitive"?: never;
  "x-immutable"?: never;
  "x-localized"?: never;
}
/** The host validates field references, value constraints and storage rules at load time. */
export interface FieldSchema extends Omit<
  SchemaConstraint,
  | "type"
  | "properties"
  | "items"
  | "default"
  | "x-ui"
  | "x-sensitive"
  | "x-immutable"
> {
  type: SchemaType;
  properties?: Record<string, FieldSchema>;
  items?: FieldSchema;
  default?: Json;
  "x-ui"?: FieldHint;
  "x-sensitive"?: boolean;
  "x-immutable"?: boolean;
}
export interface ConfigSchema extends FieldSchema {
  type: "object";
  "x-sensitive"?: false;
}
export type ParameterType = "string" | "number" | "integer" | "boolean";
export type ParameterValue = string | number | boolean;
export interface ParameterConstraint
  extends ScalarConstraints, Composition<ParameterConstraint> {
  $schema?: string;
  type?: ParameterType;
  enum?: ParameterValue[];
  const?: ParameterValue;
  default?: never;
  "x-ui"?: never;
  "x-sensitive"?: never;
  "x-immutable"?: never;
  "x-localized"?: never;
}
export interface ParameterSchema extends Omit<
  ParameterConstraint,
  "type" | "default" | "x-ui"
> {
  type: ParameterType;
  default?: ParameterValue;
  "x-ui"?: FieldHint;
}
export interface ParamsSchema {
  $schema?: string;
  type: "object";
  properties?: Record<string, ParameterSchema>;
  additionalProperties?: false;
  "x-ui"?: FieldHint;
}
