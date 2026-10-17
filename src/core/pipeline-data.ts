import type { Json, PipelineData } from "../plugins/api";
import { AppError } from "./errors";

export function assertJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") throw new Error("Expected JSON value");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Expected plain JSON object");
  if ("toJSON" in value && typeof value.toJSON === "function")
    throw new Error("Expected JSON without custom serialization");
  for (const item of Array.isArray(value) ? value : Object.values(value))
    assertJson(item);
}

/** Small execution-local JSON workspace; never persisted or shared across attempts. */
export function pipelineData(): PipelineData {
  const values = new Map<string, { json: string; size: number }>();
  let total = 0;
  return {
    get(namespace) {
      const entry = values.get(namespace);
      return entry ? (JSON.parse(entry.json) as Json) : undefined;
    },
    set(namespace, value) {
      let json: string;
      try {
        if (!namespace) throw new Error();
        assertJson(value);
        json = JSON.stringify(value);
      } catch {
        throw new AppError(
          "PIPELINE_DATA_INVALID",
          "Expected JSON pipeline data",
        );
      }
      const size = Buffer.byteLength(namespace) + Buffer.byteLength(json);
      const next = total - (values.get(namespace)?.size ?? 0) + size;
      if (next > 256 * 1024)
        throw new AppError(
          "PIPELINE_DATA_LIMIT",
          "Pipeline data exceeds 256 KiB",
        );
      values.set(namespace, { json, size });
      total = next;
    },
  };
}
