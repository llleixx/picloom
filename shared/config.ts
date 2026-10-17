import type { Json, Config, UIHints } from "../plugin-sdk/config";
export type { Json, Config, FieldHint, UIHints } from "../plugin-sdk/config";
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export type PluginKind = "path" | "storage" | "processor";
export interface StageView {
  configSchemaVersion: number;
  configSchema: Config;
  uiHints: UIHints;
  paramsSchema?: Config;
  translations?: import("./plugin-localization").PluginTranslations;
}
interface PluginIdentity {
  description?: string;
  translations?: import("./plugin-localization").PluginTranslations;
  id: string;
  name: string;
  version: string;
}
export type PluginView = PluginIdentity &
  (
    | {
        kind: "path" | "storage";
        configSchemaVersion: number;
        configSchema: Config;
        uiHints: UIHints;
      }
    | {
        kind: "processor";
        stages: Partial<Record<PipelineKind, StageView>>;
        supportedStages: PipelineKind[];
      }
  );
export type PluginSummary = PluginIdentity & {
  source?: "builtin" | "external";
  kind: PluginKind;
  supportedStages?: PipelineKind[];
};
export interface PackageView extends PluginSummary {
  source: "builtin" | "external";
  status: "loaded" | "failed";
  error: string | null;
  canUninstall: boolean;
  instances: Array<{ id: string; name: string }>;
}
export interface PluginUsage {
  key: string;
  version: string;
  ownerType: "source" | "profile" | "pipeline";
  ownerId: string;
  name: string;
  stage?: PipelineKind;
  stepIndex?: number;
}
export interface PackageInspection extends PluginSummary {
  ticket: string;
  fileCount: number;
  expandedBytes: number;
}
export interface SecretEdit {
  action: "preserve" | "replace" | "clear";
  value?: Json;
}
export interface UpgradeIntent {
  fromVersion: string;
  configVersion: number;
  secretsVersion: number;
}
export interface UpgradePreview {
  configuration: PluginConfiguration;
  fields: Array<{ path: string; message: string }>;
}
export interface PluginConfiguration {
  upgrade?: UpgradeIntent;
  key?: string;
  pluginId: string;
  version: string;
  config: Config;
  secretEdits?: Record<string, SecretEdit>;
  secretPresence?: Record<string, boolean>;
  ready?: boolean;
  error?: string | null;
}
export interface ConfiguredStep extends PluginConfiguration {
  enabledParams?: string[];
  onNotApplicable?: "skip" | "abort";
}
export type ProfileEditor = Omit<ProfileView, "pathInstanceId"> & {
  path: PluginConfiguration;
};
export type PipelineKind = "upload" | "post_save" | "access";
export interface PipelineView {
  id: string;
  name: string;
  kind: PipelineKind;
  configVersion: number;
  steps: ConfiguredStep[];
  references: Reference[];
}
export type PipelineInput = Pick<PipelineView, "name" | "kind" | "steps"> & {
  expectedVersion?: number;
};
export interface Reference {
  type: string;
  id: string;
  name: string;
}
export interface InstanceView {
  canImport: boolean;
  replicaCount: number;
  id: string;
  pluginId: string;
  version: string;
  kind: PluginKind;
  name: string;
  config: Config;
  configVersion: number;
  ready: boolean;
  error: string | null;
  secretPresence: Record<string, boolean>;
  references: Reference[];
}
export interface PipelineStep {
  instanceId: string;
  onNotApplicable?: "skip" | "abort";
}
export interface GroupView {
  id: string;
  name: string;
  primaryStrategy: "priority" | "weighted_random";
  redundancyStrategy: "priority" | "weighted_random";
  redundancyCount: number;
  configVersion: number;
  members: Array<{ instanceId: string; weight: number }>;
}
export interface ProfileView {
  id: string;
  name: string;
  publicPrefix: string;
  pathInstanceId: string;
  storageGroupId: string;
  enabled: boolean;
  allowGuestUpload?: boolean;
  configVersion: number;
  maxUploadBytes: number;
  allowedMimeTypes: string[];
  uploadPipelineId: string | null;
  postSavePipelineId: string | null;
}
export type GroupInput = Omit<GroupView, "id" | "configVersion"> & {
  expectedVersion?: number;
};
export type ProfileInput = Omit<ProfileView, "id" | "configVersion"> & {
  expectedVersion?: number;
};
export interface OperationsView {
  replicas: Array<{
    id: string;
    instanceId: string;
    name: string;
    role: string;
    status: string;
  }>;
  tasks: Array<{
    id: string;
    kind: string;
    status: string;
    attempts: number;
    error: string | null;
    failedStep?: { id: string; name: string };
    pipelineId: string | null;
  }>;
}
export function pointer(key: string) {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
export function readPointer(value: Config, path: string): Json | undefined {
  if (path === "") return value;
  let current: any = value;
  for (const key of path.slice(1).split("/"))
    current = current?.[key.replace(/~1/g, "/").replace(/~0/g, "~")];
  return current;
}
export function writePointer(
  value: Config,
  path: string,
  item: Json | undefined,
) {
  const keys = path
    .slice(1)
    .split("/")
    .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (keys.some((k) => ["__proto__", "constructor", "prototype"].includes(k)))
    throw new Error("Unsafe field");
  let current: any = value;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  if (item === undefined) delete current[keys.at(-1)!];
  else current[keys.at(-1)!] = item;
}
export function sensitivePaths(schema: Config, path = ""): string[] {
  if (
    schema["x-sensitive"] === true ||
    (schema.type === "array" &&
      JSON.stringify(schema).includes('"x-sensitive":true'))
  )
    return [path];
  return Object.entries(
    (schema.properties ?? {}) as Record<string, Config>,
  ).flatMap(([key, rule]) => sensitivePaths(rule, path + "/" + pointer(key)));
}
const keywords = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "if",
  "then",
  "else",
  "allOf",
  "x-sensitive",
  "x-immutable",
  "x-enumLabels",
]);
export function assertSchema(schema: Config) {
  assertSerializable(schema);
  if (
    schema["x-enumLabels"] !== undefined &&
    (!Array.isArray(schema.enum) ||
      !Array.isArray(schema["x-enumLabels"]) ||
      schema["x-enumLabels"].length !== schema.enum.length ||
      schema["x-enumLabels"].some((v) => typeof v !== "string"))
  )
    throw new Error("Enum labels must match enum values");
  for (const key of Object.keys(schema))
    if (!keywords.has(key))
      throw new Error(`Unsupported schema keyword: ${key}`);
  if (
    schema.type &&
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(String(schema.type))
  )
    throw new Error("Unsupported schema type");
  if (
    schema.type === "array" &&
    (!schema.items ||
      typeof schema.items !== "object" ||
      Array.isArray(schema.items))
  )
    throw new Error("Arrays require one item schema");
  if (
    schema.format &&
    ![
      "date",
      "time",
      "date-time",
      "duration",
      "email",
      "hostname",
      "ipv4",
      "ipv6",
      "uri",
      "uri-reference",
      "uuid",
      "regex",
    ].includes(String(schema.format))
  )
    throw new Error("Unsupported format");
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  )
    throw new Error("Open object schemas are not supported");
  for (const [key, rule] of Object.entries(
    (schema.properties ?? {}) as Record<string, Config>,
  )) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("Unsafe field");
    assertSchema(rule);
  }
  if (schema.items) assertSchema(schema.items as Config);
  for (const key of ["if", "then", "else"])
    if (schema[key]) assertSchema(schema[key] as Config);
  for (const item of (schema.allOf ?? []) as Config[]) assertSchema(item);
}
export function assertUIHints(value: UIHints) {
  assertSerializable(value);
  for (const [path, hint] of Object.entries(value)) {
    if (
      !path.startsWith("/") ||
      !hint ||
      typeof hint !== "object" ||
      Array.isArray(hint)
    )
      throw new Error("Invalid UI hint");
    if (
      Object.keys(hint).some(
        (k) =>
          !["group", "order", "advanced", "widget", "visibleWhen"].includes(k),
      )
    )
      throw new Error("Unsupported UI hint");
    if (
      (hint.group !== undefined && typeof hint.group !== "string") ||
      (hint.order !== undefined && !Number.isFinite(hint.order)) ||
      (hint.advanced !== undefined && typeof hint.advanced !== "boolean") ||
      (hint.widget !== undefined &&
        !["textarea", "password"].includes(hint.widget))
    )
      throw new Error("Invalid UI hint");
    if (
      hint.visibleWhen &&
      (!hint.visibleWhen.path?.startsWith("/") ||
        hint.visibleWhen.equals === undefined ||
        Object.keys(hint.visibleWhen).some(
          (k) => !["path", "equals"].includes(k),
        ))
    )
      throw new Error("Invalid condition");
  }
}
function assertSerializable(value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === undefined
  )
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite JSON value");
    return;
  }
  if (
    typeof value !== "object" ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    throw new Error("Description must be JSON data");
  for (const child of Object.values(value)) assertSerializable(child);
}
