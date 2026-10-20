/** Runtime limits shared by settings forms and the backend. */
export const runtimeDefaults = {
  maxUploadBytes: 50 * 1024 ** 2,
  chunkThresholdBytes: 8 * 1024 ** 2,
  chunkPartBytes: 4 * 1024 ** 2,
  uploadConcurrency: 4,
  partConcurrency: 2,
  uploadTempBytes: 1024 ** 3,
  uploadSessionLimit: 100,
  uploadSessionTtlMs: 86400_000,
  maxDimension: 8192,
  maxPixels: 40_000_000,
  processingConcurrency: 2,
  processingQueue: 16,
  taskConcurrency: 4,
  retryLimit: 5,
};
export type RuntimeSettings = typeof runtimeDefaults;
export const runtimeKeys = Object.keys(runtimeDefaults) as Array<
  keyof RuntimeSettings
>;
export const maxDirectUploadBytes = 20 * 1024 ** 2;
export const maxUploadBodyBytes = 5 * 1024 ** 3 + 65536;
export const runtimeMaximums: Partial<RuntimeSettings> = {
  maxUploadBytes: 5 * 1024 ** 3,
  chunkThresholdBytes: 5 * 1024 ** 3,
  chunkPartBytes: 64 * 1024 ** 2,
  uploadConcurrency: 32,
  partConcurrency: 16,
  processingConcurrency: 128,
  taskConcurrency: 128,
};
