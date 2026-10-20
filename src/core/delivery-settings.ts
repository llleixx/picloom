import { isCanonicalLocale } from "../../plugin-sdk/localization";
import { defaultLocalization, isLocale } from "../../shared/locales";
import {
  runtimeKeys,
  runtimeMaximums,
  type RuntimeSettings,
} from "../../shared/runtime-settings";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../config";
import type { DeliverySettings } from "../../shared/api";
import { AppError } from "./errors";

function validate(input: unknown): DeliverySettings {
  const fields: Array<{ path: string; message: string }> = [];
  const fail = (path: string, message: string) =>
    fields.push({ path, message });
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AppError("INVALID_INPUT", "Expected settings object");
  const v = input as Record<string, unknown>;
  for (const key of Object.keys(v))
    if (
      ![
        ...runtimeKeys,
        "guestMaxUploadBytes",
        "guestDailyUploadLimit",
        "enabledLocales",
        "defaultLocale",
        "content",
        "siteLogoUrl",
        "siteFaviconUrl",
        "cacheBytes",
        "cacheTtlMs",
        "publicOrigin",
        "imageOrigin",
        "imageCacheMaxAge",
        "hotlinkEnabled",
        "hotlinkAllowedHosts",
        "hotlinkAllowEmpty",
      ].includes(key)
    )
      fail("/" + key, "Unknown setting");
  function origin(key: string, optional = false): string | null {
    if (optional && (v[key] === null || v[key] === "")) return null;
    try {
      if (typeof v[key] !== "string") throw new Error();
      const url = new URL(v[key].trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error();
      return url.origin;
    } catch {
      fail("/" + key, "Use an HTTP(S) origin without a path.");
      return null;
    }
  }
  function text(key: string, max: number): string {
    if (v[key] === undefined) return "";
    if (typeof v[key] !== "string" || v[key].length > max) {
      fail("/" + key, `Use text up to ${max} characters.`);
      return "";
    }
    return v[key].trim();
  }
  function imageUrl(key: string): string {
    const value = text(key, 2048);
    if (!value) return "";
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
      return url.href;
    } catch {
      fail("/" + key, "Use an HTTP(S) image URL without credentials.");
      return "";
    }
  }
  const guest: {
    guestMaxUploadBytes: number | null;
    guestDailyUploadLimit: number | null;
  } = { guestMaxUploadBytes: null, guestDailyUploadLimit: null };
  for (const key of ["guestMaxUploadBytes", "guestDailyUploadLimit"] as const) {
    const n = v[key];
    if (
      n !== null &&
      (!Number.isSafeInteger(n) ||
        (n as number) < (key === "guestMaxUploadBytes" ? 1 : 0))
    )
      fail("/" + key, "Use a valid whole number or leave blank.");
    guest[key] = n as number | null;
  }
  const localization = defaultLocalization();
  if (
    !Array.isArray(v.enabledLocales) ||
    !v.enabledLocales.length ||
    !v.enabledLocales.every(isLocale) ||
    new Set(v.enabledLocales).size !== v.enabledLocales.length
  )
    fail(
      "/enabledLocales",
      "Select one or more supported languages without duplicates.",
    );
  else localization.enabledLocales = v.enabledLocales;
  if (
    !isLocale(v.defaultLocale) ||
    !localization.enabledLocales.includes(v.defaultLocale)
  )
    fail("/defaultLocale", "Default language must be enabled.");
  else localization.defaultLocale = v.defaultLocale;
  if (!v.content || typeof v.content !== "object" || Array.isArray(v.content))
    fail("/content", "Expected localized content.");
  else
    for (const [language, entry] of Object.entries(v.content)) {
      if (
        !isCanonicalLocale(language) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      ) {
        fail("/content/" + language, "Invalid content language or fields.");
        continue;
      }
      const normalized: { name?: string; description?: string } = {};
      for (const [field, value] of Object.entries(entry)) {
        if (
          (field !== "name" && field !== "description") ||
          typeof value !== "string" ||
          value.length > (field === "name" ? 100 : 300)
        )
          fail(
            `/content/${language}/${field}`,
            "Invalid content field or text length.",
          );
        else if (value.trim()) normalized[field] = value.trim();
      }
      if (Object.keys(normalized).length)
        localization.content[language] = normalized;
    }
  const branding = {
    ...localization,
    siteLogoUrl: imageUrl("siteLogoUrl"),
    siteFaviconUrl: imageUrl("siteFaviconUrl"),
  };
  const publicOrigin = origin("publicOrigin", true) ?? "";
  const imageOrigin = origin("imageOrigin", true);
  for (const key of ["hotlinkEnabled", "hotlinkAllowEmpty"])
    if (typeof v[key] !== "boolean") fail("/" + key, "Expected a boolean.");
  if (
    !Number.isSafeInteger(v.imageCacheMaxAge) ||
    (v.imageCacheMaxAge as number) < 0
  )
    fail("/imageCacheMaxAge", "Use a non-negative whole number of seconds.");
  for (const key of ["cacheBytes", "cacheTtlMs"])
    if (!Number.isSafeInteger(v[key]) || (v[key] as number) <= 0)
      fail("/" + key, "Use a positive whole number.");
  const runtime = {} as RuntimeSettings;
  for (const key of runtimeKeys) {
    const max = runtimeMaximums[key] ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(v[key]) ||
      (v[key] as number) <= 0 ||
      (v[key] as number) > max
    )
      fail("/" + key, `Use a whole number from 1 to ${max}.`);
    runtime[key] = v[key] as number;
  }
  const hosts: string[] = [];
  if (
    !Array.isArray(v.hotlinkAllowedHosts) ||
    v.hotlinkAllowedHosts.length > 200
  )
    fail("/hotlinkAllowedHosts", "Use up to 200 hostnames.");
  else
    for (const raw of v.hotlinkAllowedHosts) {
      const host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      const name = host.startsWith("*.") ? host.slice(2) : host;
      if (
        name.length > 253 ||
        !name ||
        !name
          .split(".")
          .every((label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          )
      ) {
        fail(
          "/hotlinkAllowedHosts",
          "Use hostnames such as example.com or *.example.com.",
        );
        break;
      }
      hosts.push(host);
    }
  if (fields.length)
    throw new AppError(
      "INVALID_INPUT",
      "Invalid image delivery settings",
      400,
      fields,
    );
  return {
    ...runtime,
    ...guest,
    ...branding,
    cacheBytes: v.cacheBytes as number,
    cacheTtlMs: v.cacheTtlMs as number,
    publicOrigin: publicOrigin!,
    imageCacheMaxAge: v.imageCacheMaxAge as number,
    imageOrigin,
    hotlinkEnabled: v.hotlinkEnabled as boolean,
    hotlinkAllowedHosts: [...new Set(hosts)],
    hotlinkAllowEmpty: v.hotlinkAllowEmpty as boolean,
  };
}

/** Single-process settings: persist atomically before applying to live services. */
export class DeliveryConfiguration {
  private value: DeliverySettings;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(
    private readonly config: Settings,
    private readonly applyRuntime: (value: DeliverySettings) => void,
  ) {
    this.path = join(config.root, "delivery-settings.json");
    this.value = {
      ...(Object.fromEntries(
        runtimeKeys.map((key) => [key, config[key]]),
      ) as RuntimeSettings),
      guestMaxUploadBytes: config.guestMaxUploadBytes,
      guestDailyUploadLimit: config.guestDailyUploadLimit,
      ...defaultLocalization(),
      siteLogoUrl: "",
      siteFaviconUrl: "",
      cacheBytes: config.cacheBytes,
      cacheTtlMs: config.cacheTtlMs,
      publicOrigin: config.origin,
      imageCacheMaxAge: config.imageCacheMaxAge,
      imageOrigin:
        config.imageOrigin === config.origin ? null : config.imageOrigin,
      hotlinkEnabled: config.hotlinkEnabled,
      hotlinkAllowedHosts: [...config.hotlinkAllowedHosts],
      hotlinkAllowEmpty: config.hotlinkAllowEmpty,
    };
  }
  async load() {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    this.apply(validate(JSON.parse(contents)));
  }
  get(): DeliverySettings {
    return structuredClone({ ...this.value, publicOrigin: this.config.origin });
  }
  private apply(value: DeliverySettings) {
    this.value = value;
    const { publicOrigin, ...delivery } = value;
    Object.assign(this.config, delivery, {
      origin: publicOrigin,
      secureCookie: publicOrigin.startsWith("https://"),
      imageOrigin: value.imageOrigin ?? publicOrigin,
    });
    this.applyRuntime(value);
  }
  save(input: unknown): Promise<DeliverySettings> {
    const value = validate(input);
    const operation = this.pending.then(async () => {
      const temporary = this.path + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
          mode: 0o600,
        });
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
      this.apply(value);
      return this.get();
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async close() {
    await this.pending;
  }
}
