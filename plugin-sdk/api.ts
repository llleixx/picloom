import type { Config, Json } from "./config";
export type { Config, Json } from "./config";
export type Kind = "path" | "storage" | "processor";
export type Locator = string | Config | null;
export interface Metadata {
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  animated?: boolean;
  alpha?: boolean;
}
export interface FileInput {
  readonly metadata: Readonly<Metadata>;
  openRead(): Promise<ReadableStream<Uint8Array>>;
}
export interface Output extends FileInput {
  readonly handle: string;
  readonly path: string;
}
export interface Context {
  signal: AbortSignal;
  requestId: string;
  log(event: string): void;
}
export interface PipelineDataReader {
  get(namespace: string): Json | undefined;
}
export interface PipelineData extends PipelineDataReader {
  set(namespace: string, value: Json): void;
}
export interface CheckContext extends Context {
  data: PipelineDataReader;
}
export interface PipelineContext extends Context {
  data: PipelineData;
}
export type Stage = "upload" | "access" | "post_save";
export type Parameters = Record<string, string | number | boolean>;
export type Query = Record<string, string[]>;
export interface CheckInput {
  params: Parameters;
  file: FileInput;
  limits: { maxDimension: number; maxPixels: number };
}
export interface ProcessorInput extends CheckInput {
  createOutput(): Promise<Output>;
}
export interface Runtime {
  dispose?(): void | Promise<void>;
}
export interface PathPlugin extends Runtime {
  generate(
    input: {
      fileId: string;
      uploadedAt: number;
      metadata: Metadata;
      originalName?: string;
    },
    context: Context,
  ): Promise<{ logicalKey: string; storageKey?: string }>;
}
export type ReadResult =
  | {
      type: "stream";
      stream: ReadableStream<Uint8Array>;
      mimeType?: string;
      byteSize?: number;
    }
  | { type: "redirect"; url: string; expiresAt?: number };
export interface StoragePlugin extends Runtime {
  write(
    input: {
      operationId: string;
      fileId: string;
      storageKey: string;
      file: FileInput;
    },
    context: Context,
  ): Promise<{ locator?: Locator }>;
  read(
    input: { storageKey: string; locator: Locator; mode: "auto" | "stream" },
    context: Context,
  ): Promise<ReadResult>;
  delete(
    input: { operationId: string; storageKey: string; locator: Locator },
    context: Context,
  ): Promise<void>;
  recoverWrite?(
    input: {
      operationId: string;
      fileId: string;
      storageKey: string;
      expectedSize: number;
      locator: Locator;
    },
    context: Context,
  ): Promise<
    | { status: "stored"; locator?: Locator }
    | { status: "notStored" | "unknown" }
  >;
  listFiles?(
    input: { scope?: string; cursor?: string; limit: number },
    context: Context,
  ): Promise<{
    items: Array<{
      storageKey: string;
      locator?: Locator;
      byteSize?: number;
      mimeType?: string;
    }>;
    nextCursor: string | null;
  }>;
}
export interface ProcessorPlugin<
  C = CheckInput,
  P = ProcessorInput,
> extends Runtime {
  check(
    input: C,
    context: CheckContext,
  ): Promise<{
    status: "applicable" | "noop" | "unsupported";
    reason?: string;
  }>;
  process(
    input: P,
    context: PipelineContext,
  ): Promise<
    | { status: "pass" }
    | { status: "replace"; output: Output }
    | { status: "reject"; reason: string }
  >;
}
export interface AccessCheckInput extends Omit<CheckInput, "file"> {
  readonly metadata: Readonly<Metadata>;
  getFile(): Promise<FileInput>;
}
export interface AccessProcessorInput extends AccessCheckInput {
  createOutput(): Promise<Output>;
}
export interface AccessPlugin extends ProcessorPlugin<
  AccessCheckInput,
  AccessProcessorInput
> {
  cacheable?: boolean;
}
export interface PostSaveResult {
  status: "pass" | "block" | "delete";
  /** Compact file-related JSON summary; never include secrets or file bytes. */
  details?: Config;
}
export interface PostSavePlugin extends Runtime {
  execute(
    input: {
      operationId: string;
      fileId: string;
      publicPath: string;
      url: string;
      file: FileInput;
    },
    context: PipelineContext,
  ): Promise<PostSaveResult>;
}
export interface Runtimes {
  path: PathPlugin;
  storage: StoragePlugin;
  upload: ProcessorPlugin;
  access: AccessPlugin;
  post_save: PostSavePlugin;
}
export interface InstanceServices {
  readonly images: { readonly sharp: typeof import("sharp") };
  log(event: string): void;
  readSecrets(): Promise<{ value: Config; version: number }>;
  updateSecrets(value: Config, expectedVersion: number): Promise<void>;
  readState(): Promise<{ value: Config; version: number }>;
  updateState(value: Config, expectedVersion: number): Promise<void>;
}
export interface Descriptor<R extends Runtime> {
  translations?: import("./config").PluginTranslations;
  uiHints?: import("./config").UIHints;
  configSchemaVersion: number;
  configSchema: Config;
  migrateConfig?(input: {
    from: { pluginVersion: string; configSchemaVersion: number };
    apiVersion: 1;
    config: Config;
  }): Promise<Config>;
  validateConfig?(
    config: Readonly<Config>,
  ): Promise<Array<{ message: string; path?: string }>>;
  createInstance(input: {
    id: string;
    config: Readonly<Config>;
    services: InstanceServices;
  }): Promise<R>;
}
export type StageDefinitions = {
  upload?: Descriptor<ProcessorPlugin> & { paramsSchema?: Config };
  access?: Descriptor<AccessPlugin> & { paramsSchema?: Config };
  post_save?: Descriptor<PostSavePlugin>;
};
interface Identity<K extends Kind> {
  id: string;
  name: string;
  description?: string;
  translations?: import("./config").PluginTranslations;
  kind: K;
  version: string;
  apiVersion: 1;
}
export type Definition<K extends Kind = Kind> = K extends "processor"
  ? Identity<K> & { stages: StageDefinitions }
  : K extends "path" | "storage"
    ? Identity<K> &
        Descriptor<Runtimes[K]> &
        (K extends "storage" ? { localDirectory?: { configPath: string } } : {})
    : never;
export class PluginError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public outcome: "notApplied" | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "PluginError";
  }
}

/** Structural error protocol: works when each package bundles its own SDK. */
export function isPluginError(error: unknown): error is PluginError {
  if (!error || typeof error !== "object") return false;
  const e = error as Partial<PluginError>;
  return (
    e.name === "PluginError" &&
    typeof e.message === "string" &&
    typeof e.code === "string" &&
    typeof e.retryable === "boolean" &&
    (e.outcome === "notApplied" || e.outcome === "unknown")
  );
}
