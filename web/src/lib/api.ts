import { isSiteAdmin } from "../../../shared/roles";
import { t, type MessageKey } from "./i18n";
import { QueryClient } from "@tanstack/vue-query";
import { shallowRef, computed } from "vue";
import type { ErrorResponse, SessionView } from "../../../shared/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15_000 },
    mutations: { retry: false },
  },
});
export const session = shallowRef<SessionView | null>(null);
export const isAdmin = computed(() => isSiteAdmin(session.value?.user.role));
export const notice = shallowRef("");
let noticeTimer: ReturnType<typeof setTimeout>;
export function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId = "",
    public status = 0,
    public fields: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
  }
}
const messages: Record<string, MessageKey> = {
  BACKUP_INVALID: "backup.invalid",
  BACKUP_FAILED: "backup.failed",
  BACKUP_SOURCE: "backup.source",
  BACKUP_LIMIT: "backup.limit",
  MAINTENANCE: "backup.maintenance",
  LAST_REPLICA: "replicas.lastError",
  REMOTE_IMAGE_FAILED: "errors.remoteImageFailed",
  REMOTE_IMAGE_HTTP: "errors.remoteImageHttp",
  IMPORT_UNSUPPORTED: "errors.importUnsupported",
  INVALID_CURSOR: "errors.invalidCursor",
  UPLOAD_EXPIRED: "errors.uploadExpired",
  UPLOAD_CLOSED: "errors.uploadClosed",
  TEMP_CAPACITY: "errors.temporaryFull",
  UPLOAD_CAPACITY: "errors.uploadCapacity",
  UNAUTHORIZED: "ui.sessionExpiredSignInAgain",
  INCORRECT_PASSWORD: "ui.currentPasswordIsIncorrect",
  CSRF: "ui.requestVerificationFailedRefreshAndTryAgain",
  HOTLINK_DENIED: "errors.hotlinkDenied",
  FORBIDDEN: "ui.permissionDenied",
  DAILY_UPLOAD_LIMIT: "limits.reached",
  TOO_LARGE: "ui.fileIsEmptyOrExceedsTheUpload",
  INVALID_IMAGE: "ui.invalidImageOrPixelLimitExceeded",
  RATE_LIMIT: "ui.tooManyRequestsTryAgainLater",
  UNSUPPORTED: "ui.unsupportedOperationAnimationOrTransparencyMayNot",
  INVALID_PARAMS: "ui.invalidParametersOrProcessingLimitExceeded",
  NOT_FOUND: "ui.notFound",
  PLUGIN_ERROR: "ui.pluginFailedTryAgain",
  INTERNAL: "ui.serverErrorTryAgain",
  CONFIG_INVALID: "ui.invalidConfiguration",
  NEW_INSTANCE_REQUIRED: "ui.storageLocationIsFixedCreateANew",
  INSTANCE_UNAVAILABLE:
    "ui.pluginUnavailableCheckSettingsOrRetryInitialization",
  DEFAULT_PROFILE_REQUIRED: "profiles.required",
  PIPELINE_MISSING: "errors.pipeline_missing",
  BUSY: "errors.busy",
  CONFLICT: "errors.conflict",
  DISABLED: "errors.disabled",
  INVALID_INPUT: "errors.invalid_input",
  INVALID_PATH: "errors.invalid_path",
  INVALID_PREFIX: "errors.invalid_prefix",
  INVALID_WEIGHT: "errors.invalid_weight",
  NO_PROCESSOR: "errors.no_processor",
  ORIGIN: "errors.origin",
  PLUGIN_BUILTIN: "errors.plugin_builtin",
  PLUGIN_CONFIRMATION_REQUIRED: "errors.plugin_confirmation_required",
  PLUGIN_INVALID: "errors.plugin_invalid",
  PLUGIN_PACKAGE_INVALID: "errors.plugin_package_invalid",
  PLUGIN_STAGE_EXPIRED: "errors.plugin_stage_expired",
  PLUGIN_STAGE_LIMIT: "errors.plugin_stage_limit",
  PLUGIN_VERSION: "errors.plugin_version",
  PROFILE_CHANGED: "errors.profile_changed",
  PROFILE_CLOSING: "errors.profile_closing",
  REJECTED: "errors.rejected",
  STORAGE_UNAVAILABLE: "errors.storage_unavailable",
  TEMP_MISSING: "errors.temp_missing",
  UNAVAILABLE: "errors.unavailable",
  WRITE_UNKNOWN: "errors.write_unknown",
  WRITE_FAILED: "errors.write_failed",
  DELETE_FAILED: "errors.delete_failed",
  ACTION_FAILED: "errors.action_failed",
  PROCESSING_RESULT_INVALID: "errors.processing_result_invalid",
  PLUGIN_INVALID_CONFIG: "errors.plugin_invalid_config",
  PLUGIN_INVALID_INPUT: "errors.plugin_invalid_input",
  PLUGIN_ACCESS_DENIED: "errors.plugin_access_denied",
  PLUGIN_NOT_FOUND: "errors.plugin_not_found",
  PLUGIN_CONFLICT: "errors.plugin_conflict",
  PLUGIN_RESOURCE_LIMIT: "errors.plugin_resource_limit",
  PLUGIN_RATE_LIMITED: "errors.plugin_rate_limited",
  PLUGIN_UNSUPPORTED: "errors.plugin_unsupported",
  PLUGIN_NETWORK: "errors.plugin_network",
  PLUGIN_IO: "errors.plugin_io",
  PLUGIN_INVALID_DATA: "errors.plugin_invalid_data",
  PLUGIN_SERVICE: "errors.plugin_service",
  PLUGIN_FAILED: "errors.plugin_failed",
  INTERRUPTED_TASK: "errors.interrupted_task",
  INTERRUPTED_UPLOAD: "errors.interrupted_upload",
  FRONTEND_NOT_BUILT: "errors.frontend_not_built",
  METHOD: "errors.method",
  INCOMPLETE: "errors.incomplete",
  CORRUPT: "errors.corrupt",
  LOCATOR: "errors.locator",
  PLUGIN_OUTPUT: "errors.plugin_output",
  PLUGIN_RESULT: "errors.plugin_result",
  SCHEMA_MISMATCH: "errors.schema_mismatch",
};
export function errorMessage(code?: string | null): string {
  return t(messages[code ?? ""] ?? "errors.generic");
}
export function decodeError(data: unknown, status: number) {
  const value = (data as Partial<ErrorResponse> | null)?.error;
  return new ApiError(
    value?.code ?? "HTTP_ERROR",
    value?.code
      ? errorMessage(value.code)
      : t("errors.httpStatus", { status: status }),
    value?.requestId,
    status,
    (value as { fields?: Array<{ path: string; message: string }> } | undefined)
      ?.fields ?? [],
  );
}
export function errorText(e: unknown): string {
  if (e instanceof ApiError)
    return (
      e.message +
      (e.requestId ? t("errors.requestId", { id: e.requestId }) : "")
    );
  return e instanceof Error ? e.message : t("ui.somethingWentWrongTryAgain");
}
export let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}
export const sessionCleanups = new Set<() => void>();
export function clearPrivateQueries() {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "client-settings",
  });
}
export function clearSession() {
  session.value = null;
  clearPrivateQueries();
  for (const clean of sessionCleanups) clean();
}
export async function response(
  path: string,
  init: RequestInit = {},
  expire = true,
) {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string")
    headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method) && session.value)
    headers.set("X-CSRF-Token", session.value.csrfToken);
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const error = decodeError(await res.json().catch(() => null), res.status);
    if (res.status === 401 && expire) onUnauthorized();
    throw error;
  }
  return res;
}
export async function api<T>(
  path: string,
  init?: RequestInit,
  expire = true,
): Promise<T> {
  return (await response(path, init, expire)).json();
}
export async function getSession() {
  const value = await queryClient.fetchQuery({
    queryKey: ["session"],
    staleTime: 0,
    queryFn: () => api<SessionView>("/api/auth/session", undefined, false),
  });
  session.value = value;
  return value;
}
export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(t("ui.copied"));
  } catch {
    notify(t("ui.clipboardUnavailableCopyTheLinkManually"));
  }
}
