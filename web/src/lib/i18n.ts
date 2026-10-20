import { ref, readonly, watch, computed } from "vue";
import { en } from "../locales/en";
import { zhCN } from "../locales/zh-CN";

import {
  languages,
  supportedLocales,
  selectLocale,
  isLocale,
  type Locale,
} from "../../../shared/locales";
export type { Locale } from "../../../shared/locales";
export type MessageKey = keyof typeof en;
export const languageStorageKey = "language";
function savedPreference(): Locale | null {
  try {
    const value = localStorage.getItem(languageStorageKey);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}
const preference = ref<Locale | null>(savedPreference());
export const languagePreference = readonly(preference);
const available = ref<Locale[]>([...supportedLocales]);
export const availableLocales = readonly(available);
const fallback = ref<Locale>("en-US");
function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  return [
    ...(navigator.languages ??
      (navigator.language ? [navigator.language] : [])),
  ];
}
const browser = ref(browserLanguages());
const currentLocale = computed(() =>
  selectLocale(
    preference.value,
    browser.value,
    available.value,
    fallback.value,
  ),
);
export const locale = currentLocale;
export function configureLanguages(
  locales: readonly Locale[],
  defaultLocale: Locale,
) {
  available.value = [...locales];
  fallback.value = defaultLocale;
}
export function setLocale(language: string): void {
  preference.value = isLocale(language) ? language : null;
  try {
    if (preference.value)
      localStorage.setItem(languageStorageKey, preference.value);
    else localStorage.removeItem(languageStorageKey);
  } catch {
    /* Keep the in-memory preference. */
  }
}
watch(
  currentLocale,
  (value) => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = value;
      document.documentElement.dir = languages.find(
        (language) => language.tag === value,
      )!.direction;
    }
  },
  { immediate: true },
);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === languageStorageKey || event.key === null)
      preference.value = savedPreference();
  });
  window.addEventListener("languagechange", () => {
    browser.value = browserLanguages();
  });
}
const catalogs: Record<Locale, Partial<Record<MessageKey, string>>> = {
  "en-US": en,
  "zh-CN": zhCN,
};
export function t(
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const catalog: Partial<Record<MessageKey, string>> =
    catalogs[currentLocale.value];
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
