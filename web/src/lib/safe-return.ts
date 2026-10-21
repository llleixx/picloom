import { webPages } from "../../../shared/web-routes";
export function safeReturn(value: unknown) {
  return typeof value === "string" &&
    webPages.includes(value.split("?")[0]!) &&
    value.split("?")[0] !== "/login"
    ? value
    : "/app/images";
}
