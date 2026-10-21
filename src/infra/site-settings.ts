import { AppError } from "../core/errors";
import { readFile, writeFile, rename, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeliverySettings } from "../../shared/api";
import type { Config } from "../../theme-sdk";
export interface ThemeState {
  drafts: Record<string, Config>;
  draftLanguages?: Record<
    string,
    { defaultLocale: string; languageRevision: number }
  >;
  active: { key: string; config: Config } | null;
}
export interface SiteSnapshot {
  format: 1;
  languageRevision: number;
  delivery?: DeliverySettings;
  themes: ThemeState;
}
/** One atomic publication point for site settings and theme configuration. */
export class SiteSettings {
  private value: SiteSnapshot = {
    format: 1,
    languageRevision: 0,
    themes: { drafts: {}, active: null },
  };
  private loaded = false;
  private pending: Promise<unknown> = Promise.resolve();
  readonly validators: Array<(next: SiteSnapshot) => void> = [];
  readonly listeners: Array<(next: SiteSnapshot) => void> = [];
  constructor(readonly root: string) {}
  get() {
    return structuredClone(this.value);
  }
  async load() {
    if (this.loaded) return;
    const read = async (name: string) => {
      try {
        return JSON.parse(await readFile(join(this.root, name), "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    };
    const saved = await read("site-settings.json");
    if (saved !== undefined) {
      if (
        !saved ||
        saved.format !== 1 ||
        !saved.delivery ||
        typeof saved.delivery !== "object" ||
        Array.isArray(saved.delivery) ||
        !saved.themes ||
        !saved.themes.drafts ||
        typeof saved.themes.drafts !== "object" ||
        Array.isArray(saved.themes.drafts) ||
        !Number.isInteger(saved.languageRevision)
      )
        throw new AppError("INVALID_INPUT", "Invalid site settings snapshot");
      this.value = saved;
    }
    this.loaded = true;
  }
  private async persist(value: SiteSnapshot) {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, "site-settings.json");
    try {
      await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
      await rename(path + ".tmp", path);
    } finally {
      await rm(path + ".tmp", { force: true });
    }
  }
  update(change: (next: SiteSnapshot) => void) {
    const operation = this.pending.then(async () => {
      const next = this.get();
      change(next);
      for (const validate of this.validators) validate(next);
      const before = this.value.delivery,
        after = next.delivery;
      if (
        before?.defaultLocale !== after?.defaultLocale ||
        JSON.stringify(before?.enabledLocales) !==
          JSON.stringify(after?.enabledLocales)
      )
        next.languageRevision++;
      await this.persist(next);
      this.value = next;
      for (const notify of this.listeners) notify(this.get());
      return this.get();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async close() {
    await this.pending;
  }
}
