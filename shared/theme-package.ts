export { safeName, assetPath } from "@picloom/package-rules";

export function themeAssetUrl(baseUrl: string, path: string) {
  return baseUrl + path.split("/").map(encodeURIComponent).join("/");
}
