import type { SiteLocalization } from "./locales";
import type { Config } from "./config";
import type { UserRole } from "./roles";
import type { RuntimeSettings } from "./runtime-settings";
/** Browser-safe HTTP contracts. No persistence or runtime dependencies. */
export type FileStatus =
  | "preparing"
  | "ready"
  | "blocked"
  | "failed"
  | "deleting"
  | "deleted";
export type ProcessingResult = import("../plugin-sdk/api").PostSaveStepResult;
export interface FileView {
  id: string;
  ownerId: string | null;
  ownerName?: string | null;
  /** Detail response only; pending/running background operations. */
  backgroundPending?: boolean;
  uploadProfileId?: string | null;
  /** Administrator detail response only. */
  processingResults?: ProcessingResult[] | null;
  status: FileStatus;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  publicPrefix: string;
  logicalKey: string;
  storageKey: string;
  createdAt: number;
  deletedAt: number | null;
  /** DELETE_FAILED while deleting means cleanup is stalled, not actively retrying. */
  error: string | null;
  url: string;
}
export interface UploadProfileView {
  enabled: boolean;
  id: string;
  name: string;
  publicPrefix: string;
  maxUploadBytes: number;
  allowedMimeTypes: string[];
  available: boolean;
  reason: string | null;
  reasonCode?: string | null;
}
export interface ChunkedUploadSession {
  uploadKey: string;
  id: string;
  partSize: number;
  expiresAt: number;
}
export interface SiteSettings extends SiteLocalization {
  siteLogoUrl: string;
  siteFaviconUrl: string;
}
export interface ClientSettings extends SiteSettings {
  uploadConcurrency: number;
  chunkedUpload: {
    thresholdBytes: number;
    partBytes: number;
    concurrency: number;
  };
  maxUploadBytes: number;
  maxDimension: number;
  maxPixels: number;
}
export interface SessionView {
  user: { id: string; username: string; role: UserRole };
  csrfToken: string;
}
export interface TokenView {
  profileIds: string[] | null;
  id: string;
  name?: string;
  hint?: string;
  expiresAt: number | null;
  revokedAt: number | null;
}
export interface UploadResult {
  id: string;
  url: string;
}
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
    fields?: Array<{ path: string; message: string }>;
  };
}

/** Editable image delivery settings. Null imageOrigin follows the site origin. */
export interface DeliverySettings extends RuntimeSettings, SiteSettings {
  guestMaxUploadBytes: number | null;
  guestDailyUploadLimit: number | null;
  cacheBytes: number;
  cacheTtlMs: number;
  publicOrigin: string;
  imageCacheMaxAge: number;
  imageOrigin: string | null;
  hotlinkEnabled: boolean;
  hotlinkAllowedHosts: string[];
  hotlinkAllowEmpty: boolean;
}

export interface LocalUsage {
  measuredAt: number | null;
  calculating: boolean;
  diskTotal: number | null;
  diskAvailable: number | null;
  originals: number | null;
  temporary: number | null;
  cache: number | null;
}
export interface SystemStatus {
  database: "sqlite" | "postgres";
  checkedAt: number;
  uptimeSeconds: number;
  readyFiles: number;
  originalBytes: number;
  pendingTasks: number;
  runningTasks: number;
  failedTasks: number;
  failures: Array<{
    id: string;
    fileId: string;
    logicalKey: string;
    kind: "write" | "action" | "delete";
    error: string | null;
    updatedAt: number;
  }>;
  local: LocalUsage;
}

export interface BatchDeleteResult {
  results: Array<{ id: string; accepted: boolean; error?: string }>;
}

export interface UserView {
  maxUploadBytes: number | null;
  dailyUploadLimit: number | null;
  id: string;
  username: string;
  role: UserRole;
  status: "active" | "disabled";
  profileIds: string[];
  createdAt: number;
}

export interface UploadDefaults {
  defaultProfileId: string | null;
  userDefaultProfileId: string | null;
  siteDefaultProfileId: string | null;
}
