/** Public failure reasons shared by all plugins. Retry and outcome are independent. */
export const pluginErrorCodes = [
  // Persistent plugin settings are missing or invalid.
  "INVALID_CONFIG",
  // Per-call parameters or input metadata are invalid.
  "INVALID_INPUT",
  // Authentication failed or permission was denied.
  "ACCESS_DENIED",
  // A required resource does not exist.
  "NOT_FOUND",
  // Resource state conflicts with this operation.
  "CONFLICT",
  // Size, capacity or quota exceeded (not request frequency).
  "RESOURCE_LIMIT",
  // Request frequency or concurrency was limited.
  "RATE_LIMITED",
  // The operation or format is unsupported.
  "UNSUPPORTED",
  // Network connection, transfer or request timeout.
  "NETWORK",
  // Local I/O failed without a more specific reason.
  "IO",
  // Content is corrupt/incomplete or a response violates its protocol.
  "INVALID_DATA",
  // An upstream service failed without a more specific reason.
  "SERVICE",
  // Unclassified failure. Not the same as an unknown write outcome.
  "FAILED",
] as const;
export type PluginErrorCode = (typeof pluginErrorCodes)[number];

/** Unknown external plugin codes never become platform error codes. */
export function normalizePluginErrorCode(code: string): PluginErrorCode {
  return pluginErrorCodes.includes(code as PluginErrorCode)
    ? (code as PluginErrorCode)
    : "FAILED";
}
