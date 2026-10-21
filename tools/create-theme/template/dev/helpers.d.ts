import type { Field, Json } from "@picloom/theme-sdk";
export function initialValue(schema: Field, value?: Json): Json | undefined;
export function messageText(
  catalog: {
    defaultLocale: string;
    messages: Record<string, Record<string, string>>;
  },
  locale: string,
  key: string,
): string;
export const supportedLocales: readonly string[];
export const languages: readonly {
  tag: string;
  name: string;
  direction: string;
}[];
export function safeName(value: unknown): value is string;
export function assetPath(value: unknown): value is string;
