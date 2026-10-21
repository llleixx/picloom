export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Config = Record<string, Json>;
/** Display hints on a schema node; message keys refer to its package catalog. */
export type FieldHint = {
  labelKey?: string;
  descriptionKey?: string;
  enumKeys?: string[];
  groupKey?: string;
  order?: number;
  advanced?: boolean;
  widget?: "textarea" | "password";
  visibleWhen?: { path: string; equals: Json };
};
export interface PluginLocalization {
  defaultLocale: string;
  messages: Record<string, Record<string, string>>;
  nameKey?: string;
  descriptionKey?: string;
}
