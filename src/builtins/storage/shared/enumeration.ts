import { logicalKey } from "@picloom/plugin-sdk";
import { PluginError } from "@picloom/plugin-sdk";
export function scanScope(value = "") {
  const scope = value.replace(/\/$/, "");
  if (value) logicalKey(scope);
  return scope;
}
export function decodeCursor<T>(
  cursor: string | undefined,
  scope: string,
): T | undefined {
  if (!cursor) return;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (value.scope !== scope || value.data === undefined) throw 0;
    return value.data as T;
  } catch {
    throw new PluginError(
      "INVALID_INPUT",
      "Invalid scan cursor; restart the import",
    );
  }
}
export function encodeCursor(scope: string, data: unknown) {
  return Buffer.from(JSON.stringify({ scope, data })).toString("base64url");
}
