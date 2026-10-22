import type { ConfigSchema, ParamsSchema } from "@picloom/plugin-sdk";
import type { PluginLocalization } from "@picloom/plugin-sdk";
import type { Json, Config, FieldHint } from "@picloom/plugin-sdk";
export type { Json, Config, FieldHint } from "@picloom/plugin-sdk";
export type PluginKind = "path" | "storage" | "processor";
export interface StageView {
  configSchemaVersion: number;
  configSchema: ConfigSchema;
  paramsSchema?: ParamsSchema;
}
interface PluginIdentity extends PluginLocalization {
  id: string;
  version: string;
}
export type PluginView = PluginIdentity &
  (
    | {
        kind: "path" | "storage";
        configSchemaVersion: number;
        configSchema: ConfigSchema;
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
  author?: string;
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
export interface PackageInspection {
  id: string;
  kind: PluginKind;
  version: string;
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
  maxStorageBytes: number | null;
  usedStorageBytes: number;
  reservedStorageBytes: number;
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
  selectionStrategy: "priority" | "weighted_random";
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
  maxUploadBytes: number | null;
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
    retryError?: string | null;
    replicaId?: string | null;
    error: string | null;
    failedStep?: { id: string; name: string };
    pipelineId: string | null;
  }>;
}
export {
  cloneJson,
  pointer,
  readPointer,
  writePointer,
  sensitivePaths,
  initialValue,
  initialConfig,
  assertSchema,
  DeclarationError,
} from "./field-schema";

export interface AccessParameterGroup extends PluginLocalization {
  id: string;
  plugin: { id: string };
  paramsSchema: ParamsSchema;
}
