export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Config = Record<string, Json>;
export interface FieldHint {
  group?: string;
  order?: number;
  advanced?: boolean;
  widget?: "textarea" | "password";
  visibleWhen?: { path: string; equals: Json };
}
export type UIHints = Record<string, FieldHint>;
export interface SchemaTranslation {
  title?: string;
  description?: string;
  /** Labels correspond to enum values by position; values never change. */
  enumLabels?: string[];
}
export interface PluginTranslation {
  name?: string;
  description?: string;
  configSchema?: Record<string, SchemaTranslation>;
  paramsSchema?: Record<string, SchemaTranslation>;
  /** Keys are existing UIHints group identifiers. */
  groups?: Record<string, string>;
}
export type PluginTranslations = Record<string, PluginTranslation>;
