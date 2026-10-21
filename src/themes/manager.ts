import { SiteSettings, type ThemeState as State } from "../infra/site-settings";
import { isLocale } from "../../shared/locales";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  Config,
  Manifest,
  ThemeView,
  InstalledTheme,
} from "../../theme-sdk";
import { archiveFiles, PACKAGE_LIMIT } from "../infra/archive";
import { safePath } from "../infra/files";
import { AppError } from "../core/errors";
import {
  assetPath,
  configuration,
  invalid,
  manifest,
  safeName,
} from "./schema";
export { PACKAGE_LIMIT };
export class Themes {
  private get state(): State {
    return this.store.get().themes;
  }
  private incompatible = new Set<string>();
  private installed = new Map<string, Manifest>();
  private stages = new Map<string, { manifest: Manifest; expires: number }>();
  private pending: Promise<unknown> = Promise.resolve();
  readonly root: string;
  constructor(
    private dataRoot: string,
    readonly store = new SiteSettings(dataRoot),
  ) {
    this.root = join(dataRoot, "themes");
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.pending.then(fn);
    this.pending = p.catch(() => {});
    return p;
  }
  async close() {
    await this.pending;
    for (const ticket of this.stages.keys())
      await rm(join(this.root, ".stage-" + ticket), {
        recursive: true,
        force: true,
      });
    this.stages.clear();
  }
  private async save(next: State) {
    await this.store.update((snapshot) => {
      snapshot.themes = next;
    });
  }
  async start() {
    await this.store.load();
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith(".stage-")) {
        await rm(join(this.root, entry.name), { recursive: true, force: true });
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const raw = JSON.parse(
          await readFile(join(this.root, entry.name, "theme.json"), "utf8"),
        );
        if (
          !safeName(raw.id) ||
          !safeName(raw.version) ||
          entry.name !== this.key(raw.id, raw.version)
        )
          continue;
        try {
          this.installed.set(entry.name, manifest(raw));
        } catch {
          this.incompatible.add(entry.name);
          this.installed.set(entry.name, {
            id: raw.id,
            version: raw.version,
            defaultLocale: "en-US",
            nameKey: "package.name",
            apiVersion: 1,
            supportedLocales: [],
            pages: {},
            messages: { "en-US": { "package.name": raw.id } },
          });
        }
      } catch {
        console.error(JSON.stringify({ event: "theme_package_invalid" }));
      }
    }
    this.store.validators.push((next) => {
      const key = next.themes.active?.key,
        m = key && this.installed.get(key);
      if (!m || this.incompatible.has(key!)) return;
      const site = next.delivery;
      if (
        site &&
        (!site.enabledLocales.includes(site.defaultLocale) ||
          !m.supportedLocales.includes(site.defaultLocale))
      )
        throw new AppError(
          "INVALID_INPUT",
          "The default language must be enabled and supported by the active theme",
          400,
          [
            {
              path: "/defaultLocale",
              message: "Choose a language supported by the active theme.",
            },
          ],
        );
    });
  }
  private key(id: string, version: string) {
    if (!safeName(id) || !safeName(version)) throw invalid();
    return id + "@" + version;
  }
  private get(key: string) {
    const m = this.installed.get(key);
    if (!m) throw new AppError("NOT_FOUND", "Theme not found", 404);
    return m;
  }
  private view(key: string, config: Config): ThemeView {
    const m = this.get(key);
    return {
      manifest: structuredClone(m),
      config: structuredClone(config),
      baseUrl: `/assets/themes/${m.id}/${m.version}/`,
      draftLanguage: this.state.draftLanguages?.[key],
      languageRevision: this.store.get().languageRevision,
      siteDefaultLocale: this.store.get().delivery?.defaultLocale,
      enabledLocales: this.store.get().delivery?.enabledLocales,
    };
  }
  active(): ThemeView | null {
    const a = this.state.active;
    if (!a || !this.installed.has(a.key) || this.incompatible.has(a.key))
      return null;
    const view = this.view(a.key, a.config);
    if (
      view.siteDefaultLocale &&
      !view.manifest.supportedLocales.includes(view.siteDefaultLocale)
    )
      return null;
    delete view.draftLanguage;
    delete view.languageRevision;
    return view;
  }
  list(): InstalledTheme[] {
    return [...this.installed].map(([key, m]) => ({
      ...this.view(key, this.state.drafts[key] ?? {}),
      compatible: !this.incompatible.has(key),
      active: this.state.active?.key === key,
    }));
  }
  preview(id: string, version: string) {
    const key = this.key(id, version),
      m = this.get(key);
    if (this.incompatible.has(key))
      throw invalid("Incompatible theme; install an updated version");
    const view = this.view(
      key,
      configuration(
        m.configSchema,
        this.state.drafts[key] ?? {},
        false,
        true,
        m.supportedLocales,
      ),
    );
    view.draftLanguage ??= {
      defaultLocale: view.siteDefaultLocale ?? "en-US",
      languageRevision: view.languageRevision ?? 0,
    };
    return view;
  }
  inspect(bytes: Uint8Array) {
    return this.serial(async () => {
      for (const [ticket, stage] of this.stages)
        if (stage.expires < Date.now()) {
          await rm(join(this.root, ".stage-" + ticket), {
            recursive: true,
            force: true,
          });
          this.stages.delete(ticket);
        }
      if (this.stages.size >= 8)
        throw invalid("Too many pending installations");
      let files: Map<string, Uint8Array>;
      try {
        files = archiveFiles(bytes);
      } catch {
        throw invalid(
          "Invalid theme ZIP (20 MB compressed, 50 MB expanded, 512 entries maximum)",
        );
      }
      const raw = files.get("theme.json");
      if (!raw || raw.length > 256 * 1024) throw invalid();
      let m: Manifest;
      try {
        m = manifest(JSON.parse(new TextDecoder().decode(raw)));
      } catch {
        throw invalid("Invalid theme manifest");
      }
      if (this.installed.has(this.key(m.id, m.version)))
        throw new AppError("CONFLICT", "Theme version already installed", 409);
      const refs = [
        ...(m.styles ?? []),
        ...(m.preview ? [m.preview] : []),
        ...Object.values(m.pages).flatMap((p) => [
          p.entry,
          ...(p.styles ?? []),
        ]),
      ];
      if (refs.some((p) => !files.has(p)))
        throw invalid("Missing theme entry or resource");
      const ticket = crypto.randomUUID(),
        dir = join(this.root, ".stage-" + ticket);
      try {
        for (const [name, value] of files) {
          const path = join(dir, name);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value);
        }
        this.stages.set(ticket, {
          manifest: m,
          expires: Date.now() + 15 * 60_000,
        });
        return { ticket, manifest: m };
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
    });
  }
  install(ticket: string, confirmed: boolean) {
    return this.serial(async () => {
      const stage = this.stages.get(ticket);
      if (!confirmed || !stage || stage.expires < Date.now())
        throw invalid("Installation expired or trust not confirmed");
      const m = stage.manifest,
        key = this.key(m.id, m.version);
      if (this.installed.has(key))
        throw new AppError("CONFLICT", "Theme version already installed", 409);
      await rename(join(this.root, ".stage-" + ticket), join(this.root, key));
      this.installed.set(key, m);
      try {
        const config = configuration(m.configSchema, undefined, true, false);
        await this.store.update((next) => {
          next.themes.drafts[key] = config;
        });
      } catch (error) {
        this.installed.delete(key);
        await rename(join(this.root, key), join(this.root, ".stage-" + ticket));
        throw error;
      }
      this.stages.delete(ticket);
      return this.view(key, this.state.drafts[key]!);
    });
  }
  configure(
    id: string,
    version: string,
    value: unknown,
    language?: { defaultLocale: string; languageRevision: number },
  ) {
    return this.serial(async () => {
      const key = this.key(id, version),
        m = this.get(key);
      if (this.incompatible.has(key)) throw invalid("Incompatible theme");
      const config = configuration(m.configSchema, value, false, false);
      await this.store.update((next) => {
        if (language) this.checkLanguage(m, language, next);
        next.themes.drafts[key] = config;
        if (language) (next.themes.draftLanguages ??= {})[key] = language;
      });
      return this.view(key, this.state.drafts[key]!);
    });
  }
  private checkLanguage(
    m: Manifest,
    language: { defaultLocale: string; languageRevision: number },
    next: ReturnType<SiteSettings["get"]>,
  ) {
    if (language.languageRevision !== next.languageRevision)
      throw new AppError(
        "CONFLICT",
        "Site languages changed; refresh before applying",
        409,
      );
    if (
      !isLocale(language.defaultLocale) ||
      !m.supportedLocales.includes(language.defaultLocale) ||
      !next.delivery?.enabledLocales.includes(language.defaultLocale)
    )
      throw invalid("Choose an enabled language supported by this theme");
  }
  activate(
    value: {
      id?: string;
      version?: string;
      defaultLocale?: string;
      languageRevision?: number;
    } | null,
  ) {
    return this.serial(async () => {
      await this.store.update((next) => {
        if (!value) {
          next.themes.active = null;
          return;
        }
        const key = this.key(value.id!, value.version!),
          m = this.get(key);
        if (this.incompatible.has(key)) throw invalid("Incompatible theme");
        const language = {
          defaultLocale:
            value.defaultLocale ?? next.delivery?.defaultLocale ?? "en-US",
          languageRevision: value.languageRevision ?? next.languageRevision,
        };
        this.checkLanguage(m, language, next);
        next.themes.active = {
          key,
          config: configuration(
            m.configSchema,
            next.themes.drafts[key] ?? {},
            false,
            true,
            m.supportedLocales,
          ),
        };
        next.delivery!.defaultLocale =
          language.defaultLocale as import("../../shared/locales").Locale;
      });
      return this.active();
    });
  }
  uninstall(id: string, version: string) {
    return this.serial(async () => {
      const key = this.key(id, version);
      this.get(key);
      if (this.state.active?.key === key)
        throw new AppError("CONFLICT", "Active theme cannot be removed", 409);
      const next = structuredClone(this.state);
      delete next.drafts[key];
      delete next.draftLanguages?.[key];
      await this.save(next);
      await rm(join(this.root, key), { recursive: true, force: true });
      this.installed.delete(key);
      this.incompatible.delete(key);
      return { ok: true };
    });
  }
  async resource(req: Request, id: string, version: string, path: string) {
    if (!["GET", "HEAD"].includes(req.method))
      throw new AppError("METHOD", "Method not allowed", 405);
    const key = this.key(id, version);
    this.get(key);
    if (!assetPath(path))
      throw new AppError("NOT_FOUND", "Resource not found", 404);
    const full = await safePath(join(this.root, key), path).catch(() => null);
    if (!full) throw new AppError("NOT_FOUND", "Resource not found", 404);
    const file = Bun.file(full);
    if (!(await file.exists()))
      throw new AppError("NOT_FOUND", "Resource not found", 404);
    return new Response(req.method === "HEAD" ? null : file, {
      headers: {
        "content-type": /\.m?js$/.test(path)
          ? "text/javascript; charset=utf-8"
          : file.type,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
