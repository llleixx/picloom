import {
  runtimeDefaults,
  runtimeKeys,
  runtimeMaximums,
  type RuntimeSettings,
} from "../shared/runtime-settings";
import { resolve } from "node:path";
export interface Settings extends RuntimeSettings {
  guestMaxUploadBytes: number | null;
  guestDailyUploadLimit: number | null;
  databaseUrl: string;
  guestUploadsPerMinute: number;
  trustedProxies: string[];
  root: string;
  origin: string;
  imageOrigin: string;
  hotlinkEnabled: boolean;
  hotlinkAllowedHosts: string[];
  hotlinkAllowEmpty: boolean;
  imageCacheMaxAge: number;
  port: number;
  encryptionKey: string;
  cacheBytes: number;
  cacheTtlMs: number;
  secureCookie: boolean;
  webRoot: string;
}
export function settings(overrides: Partial<Settings> = {}): Settings {
  const origin = overrides.origin ?? process.env.PUBLIC_ORIGIN ?? "";
  const key = overrides.encryptionKey ?? process.env.ENCRYPTION_KEY ?? "";
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new Error(
      "ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters",
    );
  const number = (name: string, fallback: number) =>
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  const value: Settings = {
    ...runtimeDefaults,
    guestMaxUploadBytes: null,
    guestDailyUploadLimit: null,
    databaseUrl: process.env.DATABASE_URL ?? "",
    guestUploadsPerMinute: number("GUEST_UPLOADS_PER_MINUTE", 10),
    trustedProxies: (process.env.TRUSTED_PROXIES ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    chunkThresholdBytes: number(
      "CHUNK_THRESHOLD_BYTES",
      runtimeDefaults.chunkThresholdBytes,
    ),
    chunkPartBytes: number("CHUNK_PART_BYTES", runtimeDefaults.chunkPartBytes),
    uploadConcurrency: number(
      "UPLOAD_CONCURRENCY",
      runtimeDefaults.uploadConcurrency,
    ),
    partConcurrency: number(
      "PART_CONCURRENCY",
      runtimeDefaults.partConcurrency,
    ),
    uploadSessionTtlMs: number(
      "UPLOAD_SESSION_TTL_MS",
      runtimeDefaults.uploadSessionTtlMs,
    ),
    root: resolve(process.env.DATA_DIR ?? "data"),
    origin,
    imageOrigin: overrides.imageOrigin ?? process.env.IMAGE_ORIGIN ?? origin,
    hotlinkEnabled: process.env.HOTLINK_ENABLED === "true",
    hotlinkAllowedHosts: (process.env.HOTLINK_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    hotlinkAllowEmpty: process.env.HOTLINK_ALLOW_EMPTY !== "false",
    imageCacheMaxAge: number("IMAGE_CACHE_MAX_AGE", 0),
    port: number("PORT", 3000),
    encryptionKey: key,
    uploadTempBytes: number(
      "UPLOAD_TEMP_BYTES",
      runtimeDefaults.uploadTempBytes,
    ),
    uploadSessionLimit: number(
      "UPLOAD_SESSION_LIMIT",
      runtimeDefaults.uploadSessionLimit,
    ),
    maxUploadBytes: number("MAX_UPLOAD_BYTES", runtimeDefaults.maxUploadBytes),
    maxDimension: number("MAX_DIMENSION", runtimeDefaults.maxDimension),
    maxPixels: number("MAX_PIXELS", runtimeDefaults.maxPixels),
    processingConcurrency: number(
      "PROCESSING_CONCURRENCY",
      runtimeDefaults.processingConcurrency,
    ),
    processingQueue: number(
      "PROCESSING_QUEUE",
      runtimeDefaults.processingQueue,
    ),
    cacheBytes: number("CACHE_BYTES", 1024 ** 3),
    cacheTtlMs: number("CACHE_TTL_MS", 86400_000),
    retryLimit: number("RETRY_LIMIT", runtimeDefaults.retryLimit),
    taskConcurrency: number(
      "TASK_CONCURRENCY",
      runtimeDefaults.taskConcurrency,
    ),
    secureCookie: origin.startsWith("https://"),
    webRoot: resolve("dist/web"),
    ...overrides,
  };
  if (
    !Number.isSafeInteger(value.guestUploadsPerMinute) ||
    value.guestUploadsPerMinute < 1
  )
    throw new Error("Invalid GUEST_UPLOADS_PER_MINUTE");
  if (
    value.databaseUrl &&
    !["postgres:", "postgresql:"].includes(new URL(value.databaseUrl).protocol)
  )
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  if (value.origin) {
    const parsed = new URL(value.origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== value.origin
    )
      throw new Error(
        "PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash",
      );
  }
  if (value.imageOrigin) {
    const image = new URL(value.imageOrigin);
    if (
      !["http:", "https:"].includes(image.protocol) ||
      image.origin !== value.imageOrigin
    )
      throw new Error(
        "IMAGE_ORIGIN must be an HTTP(S) origin without a path or trailing slash",
      );
  }
  for (const setting of ["HOTLINK_ENABLED", "HOTLINK_ALLOW_EMPTY"])
    if (
      process.env[setting] !== undefined &&
      !["true", "false"].includes(process.env[setting]!)
    )
      throw new Error(`${setting} must be true or false`);
  value.hotlinkAllowedHosts = value.hotlinkAllowedHosts.map((host) => {
    const wildcard = host.startsWith("*.");
    const name = (wildcard ? host.slice(2) : host).toLowerCase();
    if (
      !name ||
      !/^[a-z0-9.-]+$/.test(name) ||
      name.startsWith(".") ||
      name.endsWith(".") ||
      name.includes("..")
    )
      throw new Error(
        "HOTLINK_ALLOWED_HOSTS expects hostnames, optionally prefixed with *.",
      );
    return wildcard ? `*.${name}` : name;
  });
  for (const [key, n] of Object.entries(value))
    if (
      typeof n === "number" &&
      (!Number.isSafeInteger(n) ||
        (key === "imageCacheMaxAge" ? n < 0 : n <= 0))
    )
      throw new Error(`Invalid positive integer setting: ${key}`);
  for (const key of runtimeKeys)
    if (value[key] > (runtimeMaximums[key] ?? Number.MAX_SAFE_INTEGER))
      throw new Error(`Setting exceeds maximum: ${key}`);
  if (value.port > 65535) throw new Error("Invalid port");
  value.root = resolve(value.root);
  return value;
}
