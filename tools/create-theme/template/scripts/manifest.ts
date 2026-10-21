import { readFile } from "node:fs/promises";
import type { Manifest } from "@picloom/theme-sdk";
import { supportedLocales, safeName, assetPath } from "../dev/helpers.js";
export { assetPath } from "../dev/helpers.js";
export async function readManifest(path = "theme.json"): Promise<Manifest> {
  const value = JSON.parse(await readFile(path, "utf8"));
  const object = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  if (
    !object(value) ||
    !safeName(value.id) ||
    value.id.startsWith("builtin.") ||
    !safeName(value.version) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.supportedLocales) ||
    !value.supportedLocales.length ||
    value.supportedLocales.some((v: string) => !supportedLocales.includes(v)) ||
    new Set(value.supportedLocales).size !== value.supportedLocales.length ||
    !value.supportedLocales.includes(value.defaultLocale) ||
    !object(value.pages) ||
    !Object.keys(value.pages).length ||
    Object.keys(value.pages).some((key) => !["home", "login"].includes(key)) ||
    !object(value.messages) ||
    !object(value.messages[value.defaultLocale]) ||
    typeof value.nameKey !== "string" ||
    typeof value.messages[value.defaultLocale][value.nameKey] !== "string" ||
    !value.messages[value.defaultLocale][value.nameKey].trim()
  )
    throw Error(
      "Invalid theme.json: check identity, API, pages and language declarations",
    );
  for (const page of Object.values(value.pages) as Array<{
    entry: string;
    styles?: string[];
  }>) {
    if (!object(page) || page.entry !== "entry.js")
      throw Error(
        "This template builds src/entry.ts as entry.js; use that entry for each page",
      );
    if (
      page.styles !== undefined &&
      (!Array.isArray(page.styles) ||
        page.styles.some((p) => !assetPath(p) || !p.endsWith(".css")))
    )
      throw Error("Invalid page styles");
  }
  if (
    value.styles !== undefined &&
    (!Array.isArray(value.styles) ||
      value.styles.some((p: unknown) => !assetPath(p) || !p.endsWith(".css")))
  )
    throw Error("Invalid styles");
  if (
    value.preview !== undefined &&
    (!assetPath(value.preview) || !/\.(png|jpe?g|webp)$/i.test(value.preview))
  )
    throw Error("Invalid preview image");
  if (value.configSchema !== undefined && value.configSchema?.type !== "object")
    throw Error("configSchema must be an object schema");
  return value as Manifest;
}
