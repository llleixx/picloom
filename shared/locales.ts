import { type LocalizedContent } from "../plugin-sdk/localization";
export const languages = [
  {
    tag: "zh-CN",
    name: "简体中文",
    direction: "ltr",
    // Regional Chinese preferences currently fall back to Simplified Chinese.
    aliases: ["zh"],
  },
  {
    tag: "en-US",
    name: "English",
    direction: "ltr",
    aliases: ["en"],
  },
] as const;
export type Locale = (typeof languages)[number]["tag"];
export const supportedLocales: Locale[] = languages.map(
  (language) => language.tag,
);
export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && supportedLocales.includes(value as Locale)
  );
}
export function matchLocale(
  value: string,
  available: readonly Locale[],
): Locale | undefined {
  const tag = value.toLowerCase();
  const exact = available.find((locale) => locale.toLowerCase() === tag);
  if (exact) return exact;
  return languages.find(
    (language) =>
      available.includes(language.tag) &&
      language.aliases.some(
        (alias) =>
          tag === alias.toLowerCase() ||
          tag.startsWith(alias.toLowerCase() + "-"),
      ),
  )?.tag;
}
export function selectLocale(
  preference: string | null,
  browser: readonly string[],
  available: readonly Locale[],
  fallback: Locale,
): Locale {
  if (preference && isLocale(preference) && available.includes(preference))
    return preference;
  for (const language of browser) {
    const match = matchLocale(language, available);
    if (match) return match;
  }
  return available.includes(fallback) ? fallback : (available[0] ?? "en-US");
}
export interface SiteLocalization extends LocalizedContent<{
  name?: string;
  description?: string;
}> {
  enabledLocales: Locale[];
  defaultLocale: Locale;
}
export function defaultLocalization(): SiteLocalization {
  return {
    enabledLocales: [...supportedLocales],
    defaultLocale: "en-US",
    content: {},
  };
}
export function siteText(
  site: SiteLocalization,
  locale: Locale,
  field: "name" | "description",
): string {
  return site.content[locale]?.[field] ?? "";
}
