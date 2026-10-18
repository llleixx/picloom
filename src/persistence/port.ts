import type { UserRole } from "../../shared/roles";
import type { Config, Kind, Locator } from "../plugins/api";
export interface Entity {
  id: string;
  created_at: number;
  updated_at: number;
}
export interface User extends Entity {
  max_upload_bytes: number | null;
  daily_upload_limit: number | null;
  username: string;
  password_hash: string;
  role: UserRole;
  status: "active" | "disabled";
  auth_version: number;
}
export interface Credential extends Entity {
  user_id: string;
  token_hash: string;
  auth_version?: number;
  expires_at: number | null;
  revoked_at: number | null;
  name?: string;
  token_hint?: string;
  allowed_profile_ids?: string[] | null;
}
export interface Instance extends Entity {
  stage: import("../plugins/api").Stage | null;
  plugin_id: string;
  plugin_version: string;
  kind: Kind;
  name: string;
  config_json: Config;
  config_version: number;
  config_schema_version: number;
  secrets_encrypted: string | null;
  secrets_version: number;
  state_json: Config;
  state_version: number;
  last_init_error: string | null;
}
export interface Group extends Entity {
  name: string;
  primary_strategy: "priority" | "weighted_random";
  redundancy_strategy: "priority" | "weighted_random";
  redundancy_count: number;
  config_version: number;
}
export interface Pipeline extends Entity {
  name: string;
  kind: "upload" | "post_save" | "access";
  config_version: number;
}
export interface Profile extends Entity {
  upload_pipeline_id: string | null;
  post_save_pipeline_id: string | null;
  name: string;
  public_prefix: string;
  path_instance_id: string;
  storage_group_id: string;
  enabled: boolean;
  allow_guest_upload?: boolean;
  config_version: number;
  max_upload_bytes: number;
  allowed_mime_types: string[];
}
export interface Step extends Entity {
  enabled_params: string[];
  pipeline_id: string;
  position: number;
  plugin_instance_id: string;
  on_not_applicable: "skip" | "abort" | null;
}
export interface FileRecord extends Entity {
  processing_results_json: import("../../shared/api").ProcessingResult[] | null;
  owner_id: string | null;
  guest_ip: string | null;
  upload_profile_id: string | null;
  storage_group_id: string | null;
  public_prefix: string;
  logical_key: string;
  storage_key: string;
  mime_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  status: "preparing" | "ready" | "blocked" | "failed" | "deleting" | "deleted";
  temp_path: string | null;
  temp_status: "available" | "missing" | "cleaned";
  last_error: string | null;
  deleted_at: number | null;
}
export type ReplicaStatus =
  | "pending"
  | "writing"
  | "ready"
  | "write_failed"
  | "write_unknown"
  | "delete_pending"
  | "deleting"
  | "delete_failed"
  | "delete_unknown"
  // Terminal: no remaining remote cleanup, including a cancelled unwritten replica.
  | "deleted";
export interface Replica extends Entity {
  file_id: string;
  storage_instance_id: string;
  role: "primary" | "redundant";
  status: ReplicaStatus;
  locator_json: Locator;
}
export interface Task extends Entity {
  kind: "write" | "action" | "delete";
  file_id: string;
  replica_id: string | null;
  pipeline_id: string | null;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  attempts: number;
  next_run_at: number | null;
  last_error: string | null;
}
export interface SystemSummary {
  readyFiles: number;
  originalBytes: number;
  pendingTasks: number;
  runningTasks: number;
  failedTasks: number;
  failures: Array<{
    id: string;
    fileId: string;
    logicalKey: string;
    kind: Task["kind"];
    error: string | null;
    updatedAt: number;
  }>;
}
export interface UploadSession extends Entity {
  upload_key_hash: string;
  owner_id: string | null;
  guest_ip: string | null;
  source_token_id: string | null;
  profile_id: string;
  source_name: string;
  params_json: Record<string, unknown>;
  byte_size: number;
  part_size: number;
  status: "pending" | "completing" | "completed" | "failed";
  file_id: string;
  expires_at: number;
}
export interface Repositories {
  dailyUploadCount(subject: string, day: string): Promise<number>;
  consumeDailyUpload(
    subject: string,
    day: string,
    limit: number | null,
  ): Promise<boolean>;
  clearDailyUploads(before: string): Promise<void>;
  setUserUploadLimits(
    id: string,
    maxBytes: number | null,
    dailyLimit: number | null,
  ): Promise<void>;
  uploadSession(id: string): Promise<UploadSession | null>;
  uploadSessions(): Promise<UploadSession[]>;
  insertUploadSession(value: UploadSession): Promise<void>;
  saveUploadSession(value: UploadSession): Promise<void>;
  deleteUploadSession(id: string): Promise<void>;
  systemSummary(): Promise<SystemSummary>;
  user(id: string): Promise<User | null>;
  userByName(name: string): Promise<User | null>;
  userCount(): Promise<number>;
  owners(): Promise<User[]>;
  users(
    limit: number,
    offset: number,
    q?: string,
    status?: string,
  ): Promise<User[]>;
  countUsers(q?: string, status?: string): Promise<number>;
  updateUser(
    id: string,
    role: User["role"],
    status: User["status"],
  ): Promise<void>;
  revokeUserCredentials(id: string): Promise<void>;
  userProfiles(id: string): Promise<string[]>;
  profilesForUsers(ids: string[]): Promise<Map<string, string[]>>;
  replaceUserProfiles(id: string, profiles: string[]): Promise<void>;
  tokenById(id: string): Promise<Credential | null>;
  insertUser(user: User): Promise<void>;
  changePassword(
    id: string,
    expectedVersion: number,
    hash: string,
  ): Promise<void>;
  credential(
    kind: "session" | "token",
    hash: string,
  ): Promise<Credential | null>;
  insertCredential(kind: "session" | "token", value: Credential): Promise<void>;
  revokeCredential(
    kind: "session" | "token",
    id: string,
    userId: string,
  ): Promise<void>;
  tokens(userId: string): Promise<Credential[]>;
  instances(ids?: string[]): Promise<Instance[]>;
  referencesForInstances(
    ids: string[],
  ): Promise<Map<string, import("../../shared/config").Reference[]>>;
  replicaCounts(ids: string[]): Promise<Map<string, number>>;
  instanceReferences(
    id: string,
  ): Promise<import("../../shared/config").Reference[]>;
  instanceReplicaCount(id: string): Promise<number>;
  deleteInstance(id: string): Promise<void>;
  pruneTerminalReferences(id: string): Promise<void>;
  instance(id: string): Promise<Instance | null>;
  saveInstance(value: Instance, expectedVersion?: number): Promise<void>;
  initError(id: string, error: string | null): Promise<void>;
  updateSecrets(
    id: string,
    value: string,
    expectedVersion: number,
  ): Promise<void>;
  updateState(
    id: string,
    value: Config,
    expectedVersion: number,
  ): Promise<void>;
  group(id: string): Promise<Group | null>;
  groups(): Promise<Group[]>;
  saveGroup(value: Group, expectedVersion: number): Promise<void>;
  replaceMembers(
    groupId: string,
    members: Array<{ instanceId: string; weight: number }>,
  ): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  members(
    id: string,
  ): Promise<
    Array<{ storage_instance_id: string; priority: number; weight: number }>
  >;
  membersForGroups(
    ids: string[],
  ): Promise<
    Map<
      string,
      Array<{ storage_instance_id: string; priority: number; weight: number }>
    >
  >;
  insertGroup(value: Group): Promise<void>;
  insertMember(
    groupId: string,
    instanceId: string,
    priority: number,
    weight: number,
  ): Promise<void>;
  profile(id: string): Promise<Profile | null>;
  profiles(): Promise<Profile[]>;
  insertProfile(value: Profile): Promise<void>;
  saveProfile(value: Profile, expectedVersion: number): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  pipelines(): Promise<Pipeline[]>;
  pipeline(id: string): Promise<Pipeline | null>;
  accessPipeline(): Promise<Pipeline | null>;
  insertPipeline(value: Pipeline): Promise<void>;
  savePipeline(value: Pipeline, expectedVersion: number): Promise<void>;
  deletePipeline(id: string): Promise<void>;
  replaceSteps(pipelineId: string, steps: Step[]): Promise<void>;
  steps(pipelineId: string): Promise<Step[]>;
  stepsForPipelines(ids: string[]): Promise<Map<string, Step[]>>;
  insertStep(value: Step): Promise<void>;
  prefixes(excludeProfileId?: string): Promise<string[]>;
  file(id: string): Promise<FileRecord | null>;
  objectRegistered(
    instanceId: string,
    storageKey: string,
    locator: Locator,
  ): Promise<boolean>;
  fileByPath(prefix: string, key: string): Promise<FileRecord | null>;
  files(
    limit: number,
    offset: number,
    filter?: FileFilter,
  ): Promise<FileRecord[]>;
  pendingFileDeletions(fileIds: string[]): Promise<string[]>;
  countFiles(filter?: FileFilter): Promise<number>;
  filesInStates(states: FileRecord["status"][]): Promise<FileRecord[]>;
  filesNeedingCleanup(): Promise<FileRecord[]>;
  insertFile(value: FileRecord): Promise<void>;
  fillFileMetadata(
    id: string,
    metadata: Pick<FileRecord, "mime_type" | "byte_size" | "width" | "height">,
  ): Promise<void>;
  saveFile(
    value: FileRecord,
    expectedStatus: FileRecord["status"],
  ): Promise<void>;
  replicas(fileId: string): Promise<Replica[]>;
  replica(id: string): Promise<Replica | null>;
  insertReplica(value: Replica): Promise<void>;
  saveReplica(value: Replica): Promise<void>;
  tasks(fileId: string): Promise<Task[]>;
  task(id: string): Promise<Task | null>;
  insertTask(value: Task): Promise<void>;
  saveTask(value: Task, expectedStatus?: Task["status"]): Promise<void>;
  dueTasks(
    now: number,
    options?: {
      limit: number;
      excludedFiles: string[];
      excludedTasks: string[];
    },
  ): Promise<Task[]>;
  recoverTasks(): Promise<void>;
}
export interface FileFilter {
  storageInstanceId?: string;
  ownerId?: string | null;
  createdFrom?: number;
  createdBefore?: number;
  status?: FileRecord["status"];
  mimeType?: string;
  q?: string;
}
export interface Persistence {
  read<T>(fn: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Database-only callback; PostgreSQL may replay it after a serialization failure. */
  transaction<T>(fn: (repositories: Repositories) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function entity(): Entity {
  return {
    id: crypto.randomUUID(),
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}
