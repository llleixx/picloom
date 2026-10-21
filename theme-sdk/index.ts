/** Browser-only public contract. No application/runtime imports. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Config = Record<string, Json>;
export type Page = "home" | "login";
export type Locale = string;
export interface Field {
  type: "object" | "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  properties?: Record<string, Field>;
  required?: string[];
  enum?: (string | number | boolean)[];
  default?: Json;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  "x-multiline"?: boolean;
  "x-localized"?: boolean;
  content?: Partial<
    Record<
      Locale,
      { title?: string; description?: string; enumLabels?: string[] }
    >
  >;
}
export interface Manifest {
  id: string;
  /** Package text fallback only; does not select the visitor or site language. */
  defaultLocale: Locale;
  content: Partial<Record<Locale, { name: string }>>;
  version: string;
  apiVersion: 1;
  supportedLocales: Locale[];
  pages: Partial<Record<Page, { entry: string; styles?: string[] }>>;
  styles?: string[];
  preview?: string;
  configSchema?: Field;
  messages?: Partial<Record<Locale, Record<string, string>>>;
}
export interface ThemeView {
  manifest: Manifest;
  config: Config;
  baseUrl: string;
  draftLanguage?: { defaultLocale: string; languageRevision: number };
  languageRevision?: number;
  siteDefaultLocale?: string;
  enabledLocales?: string[];
}
export interface InstalledTheme extends ThemeView {
  active: boolean;
  compatible: boolean;
}
export interface Profile {
  id: string;
  name: string;
  enabled: boolean;
  available: boolean;
  maxUploadBytes: number;
  allowedMimeTypes: string[];
  reason: string | null;
}
export interface Upload {
  id: string;
  name: string;
  size: number;
  profileName: string;
  sourceUrl?: string;
  status:
    | "queued"
    | "uploading"
    | "processing"
    | "success"
    | "failed"
    | "cancelled";
  progress: number;
  resumable?: boolean;
  error?: string;
  result?: { id: string; url: string };
}
export interface Snapshot {
  page: Page;
  site: {
    name: string;
    homeTitle: string;
    description: string;
    logoUrl: string;
    faviconUrl: string;
  };
  user: { name: string } | null;
  locale: Locale;
  locales: readonly Locale[];
  languages: readonly { tag: string; name: string; direction: string }[];
  /** Effective site default (or the preview draft choice), not the package default. */
  defaultLocale: string;
  mode: "light" | "dark" | "auto";
  dark: boolean;
  profiles: readonly Profile[];
  selectedProfileId: string;
  uploads: readonly Upload[];
  loading: boolean;
  error: string;
  login: {
    busy: boolean;
    error: string;
    expired: boolean;
    unavailable: boolean;
  };
  copy: { format: string; auto: boolean; formats: readonly string[] };
  notice: string;
}
export interface ThemeContext {
  apiVersion: 1;
  config: Config;
  getSnapshot(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  asset(path: string): string;
  t(key: string, params?: Record<string, string | number>): string;
  localized(value: Json | undefined): string;
  setLocale(locale: Locale): void;
  setMode(mode: Snapshot["mode"]): void;
  navigate(page: Page | "app"): void;
  selectProfile(id: string): void;
  refresh(): Promise<void>;
  uploads: {
    add(files: File[]): void;
    addUrls(urls: string[]): void;
    cancel(id: string): Promise<void>;
    resume(id: string): void;
    dismiss(id: string): Promise<void>;
  };
  links: {
    format(url: string): string;
    copy(url: string): Promise<void>;
    copyAll(): Promise<void>;
    setPreferences(format: string, auto: boolean): void;
  };
  login(username: string, password: string): Promise<void>;
}
export interface ThemeModule {
  mount(
    container: HTMLElement,
    context: ThemeContext,
  ): { dispose(): void } | Promise<{ dispose(): void }>;
}
