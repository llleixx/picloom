import type { ParamsSchema } from "../../plugin-sdk/schema";
import { compileSchema } from "./schema-validation";
import { AppError } from "./errors";
import type { Parameters, Query } from "../plugins/api";

export function parseQuery(search: URLSearchParams): Query {
  if (search.toString().length > 8192 || [...search].length > 64)
    throw new AppError("INVALID_PARAMS", "Too many query parameters");
  const result: Query = Object.create(null);
  for (const [key, value] of search) (result[key] ??= []).push(value);
  return result;
}
export function requestParameters(
  schema: ParamsSchema | undefined,
  enabled: string[],
  query: Query | Record<string, unknown>,
  source: "query" | "body" = "query",
): Parameters {
  const result: Parameters = Object.create(null);
  const properties = schema?.properties ?? {};
  for (const key of enabled) {
    const rule = properties[key];
    if (!rule || !Object.hasOwn(query, key)) continue;
    let value: unknown = query[key];
    if (source === "query") {
      const values = value as string[];
      if (values.length !== 1)
        throw new AppError(
          "INVALID_PARAMS",
          "Repeated scalar parameter: " + key,
        );
      const raw = values[0]!;
      value = raw;
      if (rule.type === "boolean") {
        if (raw !== "true" && raw !== "false")
          throw new AppError("INVALID_PARAMS", "Expected boolean: " + key);
        value = raw === "true";
      } else if (rule.type === "integer" || rule.type === "number") {
        if (!/^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw))
          throw new AppError("INVALID_PARAMS", "Expected number: " + key);
        value = Number(raw);
      }
    }
    if (!compileSchema(rule)(value))
      throw new AppError("INVALID_PARAMS", "Invalid parameter: " + key);
    result[key] = value as string | number | boolean;
  }
  return result;
}

export function parseUploadParams(
  value: FormDataEntryValue | null,
): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value !== "string" || value.length > 8192)
    throw new AppError(
      "INVALID_PARAMS",
      "Expected a params JSON object (maximum 8192 characters)",
    );
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > 64
    )
      throw new Error("Invalid object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(
      "INVALID_PARAMS",
      "Expected a params JSON object (maximum 64 fields)",
    );
  }
}
