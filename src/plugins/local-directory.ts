import { isAbsolute } from "node:path";
import type { Config, Definition, FieldSchema } from "@picloom/plugin-sdk";
import { readPointer } from "../../shared/config";

export function validConfigPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    /^\/(?:[^~\/]|~[01])+(?:\/(?:[^~\/]|~[01])+)*$/.test(path) &&
    !path
      .split("/")
      .slice(1)
      .some((k) =>
        ["__proto__", "prototype", "constructor"].includes(
          k.replace(/~1/g, "/").replace(/~0/g, "~"),
        ),
      )
  );
}
export function assertLocalDirectory(def: Definition) {
  if (!("localDirectory" in def) || def.localDirectory === undefined) return;
  if (def.kind !== "storage" || !validConfigPath(def.localDirectory.configPath))
    throw new Error("Invalid local directory declaration");
  if (def.configSchema === undefined)
    throw new Error("Unknown local directory field");
  let schema: FieldSchema = def.configSchema;
  for (const key of def.localDirectory.configPath.slice(1).split("/")) {
    if (schema["x-sensitive"])
      throw new Error("Local directory must be public configuration");
    const next =
      schema.properties?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (!next) throw new Error("Unknown local directory field");
    schema = next;
  }
  if (
    schema.type !== "string" ||
    schema["x-sensitive"] ||
    schema["x-immutable"] !== true
  )
    throw new Error(
      "Local directory must be an immutable, non-sensitive string",
    );
}
export function directoryRoot(config: Config, path: string): string {
  const root = readPointer(config, path);
  if (typeof root !== "string" || !isAbsolute(root))
    throw new Error("Local directory must be absolute");
  return root;
}
