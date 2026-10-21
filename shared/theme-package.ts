/** Pure package identity/resource rules shared by the host and generated tooling. */
export const safeName = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(v) &&
  !v.endsWith(".");
export const assetPath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 240 &&
  !/[\\:< >"|?*\x00-\x1f]/.test(v) &&
  v.split("/").every((p) => !!p && p !== "." && p !== ".." && !/[. ]$/.test(p));
