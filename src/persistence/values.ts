/** SQL integers and aggregate results use the same safe-number boundary. */
export function integer(value: unknown): number {
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "string"
  )
    throw new Error("Invalid database integer");
  if (typeof value === "string" && !/^-?\d+$/.test(value))
    throw new Error("Invalid database integer");
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error("Database integer exceeds safe range");
  return result;
}
