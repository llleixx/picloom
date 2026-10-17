import { ref, readonly, watch } from "vue";
import { en } from "../locales/en";
import { zhCN } from "../locales/zh-CN";

export type Locale = "en-US" | "zh-CN";
export type MessageKey = keyof typeof en;
export const languageStorageKey = "language";
export function resolveLocale(language: string | null | undefined): Locale {
  return language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(languageStorageKey);
    if (saved) return resolveLocale(saved);
  } catch {
    /* Storage may be blocked by the browser. */
  }
  return resolveLocale(
    typeof navigator === "undefined" ? undefined : navigator.language,
  );
}
const currentLocale = ref<Locale>(initialLocale());
export const locale = readonly(currentLocale);
export function setLocale(language: string): void {
  currentLocale.value = resolveLocale(language);
  try {
    localStorage.setItem(languageStorageKey, currentLocale.value);
  } catch {
    /* Keep the in-memory preference. */
  }
}
watch(
  currentLocale,
  (value) => {
    if (typeof document !== "undefined") document.documentElement.lang = value;
  },
  { immediate: true },
);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === languageStorageKey)
      currentLocale.value = event.newValue
        ? resolveLocale(event.newValue)
        : resolveLocale(navigator.language);
  });
}
export function t(
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const catalog: Partial<Record<MessageKey, string>> =
    currentLocale.value === "zh-CN" ? zhCN : en;
  return (catalog[key] ?? en[key]).replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(currentLocale.value, options).format(value);
}
export function formatDate(value: number): string {
  return new Intl.DateTimeFormat(currentLocale.value, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(value);
}
