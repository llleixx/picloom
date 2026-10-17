/** Public UI routes; API authorization remains on the server. */
export const adminPages = [
  "/app/users",
  "/app/plugins",
  "/app/settings",
  "/app/system",
  "/app/config/sources",
  "/app/config/groups",
  "/app/config/profiles",
  "/app/config/pipelines",
];
export const webPages = [
  "/",
  "/login",
  "/app/images",
  "/app/tokens",
  "/app/account",
  ...adminPages,
];
export const webNamespaces = ["/app/", "/login/", "/assets/"];
export function isWebRequest(path: string) {
  return (
    path === "/" ||
    webNamespaces.some((p) => path === p.slice(0, -1) || path.startsWith(p))
  );
}
export function reservedPrefix(value: string) {
  return (
    value === "/" ||
    ["/api/", ...webNamespaces].some((p) => value.startsWith(p))
  );
}
