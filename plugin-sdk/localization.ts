/** Locale codes are canonical BCP 47 tags. Each resource owns its fallback. */
export interface LocalizedContent<T> {
  defaultLocale: string;
  content: Record<string, T | undefined>;
}
export function isCanonicalLocale(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}
export function localeCandidates(locale: string, fallback: string): string[] {
  const tag = Intl.getCanonicalLocales(locale)[0]!;
  return [
    ...new Set([
      tag,
      tag.split("-")[0]!,
      Intl.getCanonicalLocales(fallback)[0]!,
    ]),
  ];
}
/** Resolve one display field. Missing and blank translations never hide a fallback. */
export function localizedText<T>(
  resource: LocalizedContent<T>,
  locale: string,
  field: (content: T) => string | undefined,
  fallback = "",
): string {
  for (const language of localeCandidates(locale, resource.defaultLocale)) {
    const content = resource.content[language];
    const value = content && field(content)?.trim();
    if (value) return value;
  }
  return fallback;
}
