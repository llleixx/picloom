import { publicPath, publicPathKey } from "../infra/files";
import { integer } from "./values";
import { isDeepStrictEqual } from "node:util";
import { sql, type Kysely } from "kysely";
import { Conflict } from "../core/errors";
import type {
  Repositories,
  User,
  Credential,
  Instance,
  Group,
  Profile,
  Pipeline,
  Step,
  FileRecord,
  FileFilter,
  Replica,
  Task,
  UploadSession,
  SystemSummary,
} from "./port";
import type { Config, Locator } from "../plugins/api";

function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

const jsonKeys = [
  "processing_results_json",
  "params_json",
  "allowed_profile_ids",
  "config_json",
  "enabled_params",
  "state_json",
  "allowed_mime_types",
  "locator_json",
] as const;
type JsonKey = (typeof jsonKeys)[number];
type Stored<T> = {
  [K in keyof T]: K extends JsonKey
    ? string | Extract<T[K], null | undefined>
    : T[K] extends boolean
      ? number
      : T[K] extends boolean | undefined
        ? number | undefined
        : T[K];
};
export interface Schema {
  daily_upload_usage: { subject: string; day: string; upload_count: number };
  users: Stored<User>;
  sessions: Stored<
    Omit<
      Credential,
      | "name"
      | "token_hint"
      | "allowed_profile_ids"
      | "auth_version"
      | "expires_at"
    > & { auth_version: number; expires_at: number }
  >;
  api_tokens: Stored<
    Omit<
      Credential,
      "auth_version" | "name" | "token_hint" | "allowed_profile_ids"
    > & {
      name: string;
      token_hint: string;
      allowed_profile_ids: string[] | null;
    }
  >;
  plugin_instances: Stored<Instance>;
  storage_groups: Stored<Group>;
  storage_group_members: {
    group_id: string;
    storage_instance_id: string;
    priority: number;
    weight: number;
  };
  upload_profiles: Stored<Profile>;
  pipelines: Stored<Pipeline>;
  pipeline_steps: Stored<Step>;
  files: Stored<FileRecord> & { public_path: string };
  file_replicas: Stored<Replica>;
  tasks: Stored<Task>;
  upload_sessions: Stored<UploadSession>;
  user_upload_profiles: { user_id: string; upload_profile_id: string };
  schema_info: { id: number; checksum: string };
}
const jsonFields = new Set<string>(jsonKeys);
// JSON payload numbers retain their own semantics. Top-level numeric columns
// are safe integers except weight; add any future fractional column explicitly.
function encode<T extends object>(value: T): Stored<T> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        k,
        v === null
          ? null
          : jsonFields.has(k)
            ? JSON.stringify(v)
            : typeof v === "boolean"
              ? Number(v)
              : typeof v === "number" && k !== "weight"
                ? integer(v)
                : v,
      ]),
  ) as Stored<T>;
}
function decode<T>(row: unknown): T {
  const result = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(result)) {
    if (jsonFields.has(key) && typeof result[key] === "string")
      result[key] = JSON.parse(result[key] as string);
    if (typeof result[key] === "number" && key !== "weight")
      result[key] = integer(result[key]);
    if (
      key === "is_default" ||
      key === "enabled" ||
      key === "allow_guest_upload" ||
      key === "manual_retry"
    )
      result[key] = result[key] === 1;
  }
  return result as T;
}
export class SqlRepositories implements Repositories {
  active = true;
  constructor(
    private connection: Kysely<Schema>,
    private dialect: "sqlite" | "postgres",
  ) {}
  private get db() {
    if (!this.active) throw new Error("Transaction context has expired");
    return this.connection;
  }
  private async rows<T>(query: {
    execute(): Promise<unknown[]>;
  }): Promise<T[]> {
    return (await query.execute()).map(decode<T>);
  }
  private async first<T>(query: {
    executeTakeFirst(): Promise<unknown>;
  }): Promise<T | null> {
    const row = await query.executeTakeFirst();
    return row ? decode<T>(row) : null;
  }
  private contains(column: string, value: string) {
    return this.dialect === "sqlite"
      ? sql<boolean>`instr(${sql.ref(column)},${value})>0`
      : sql<boolean>`strpos(${sql.ref(column)},${value})>0`;
  }
  async dailyUploadCount(subject: string, day: string) {
    const row = await this.db
      .selectFrom("daily_upload_usage")
      .select("upload_count")
      .where("subject", "=", subject)
      .where("day", "=", day)
      .executeTakeFirst();
    return row ? integer(row.upload_count) : 0;
  }
  async consumeDailyUpload(subject: string, day: string, limit: number | null) {
    if (limit === 0) return false;
    const row = await this.db
      .insertInto("daily_upload_usage")
      .values({ subject, day, upload_count: 1 })
      .onConflict((oc) => {
        const update = oc.columns(["subject", "day"]).doUpdateSet({
          upload_count: sql`daily_upload_usage.upload_count + 1`,
        });
        return limit === null
          ? update
          : update.where("daily_upload_usage.upload_count", "<", limit);
      })
      .returning("upload_count")
      .executeTakeFirst();
    return !!row;
  }
  async clearDailyUploads(before: string) {
    await this.db
      .deleteFrom("daily_upload_usage")
      .where("day", "<", before)
      .execute();
  }
  async setUserUploadLimits(
    id: string,
    maxBytes: number | null,
    dailyLimit: number | null,
  ) {
    await this.db
      .updateTable("users")
      .set({
        max_upload_bytes: maxBytes,
        daily_upload_limit: dailyLimit,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .execute();
  }
  async uploadSession(id: string) {
    return this.first<UploadSession>(
      this.db.selectFrom("upload_sessions").selectAll().where("id", "=", id),
    );
  }
  async uploadSessions() {
    return this.rows<UploadSession>(
      this.db.selectFrom("upload_sessions").selectAll(),
    );
  }
  async insertUploadSession(v: UploadSession) {
    await this.db.insertInto("upload_sessions").values(encode(v)).execute();
  }
  async saveUploadSession(v: UploadSession) {
    const result = await this.db
      .updateTable("upload_sessions")
      .set(encode(v))
      .where("id", "=", v.id)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async deleteUploadSession(id: string) {
    await this.db.deleteFrom("upload_sessions").where("id", "=", id).execute();
  }
  async systemSummary(): Promise<SystemSummary> {
    const files = await this.db
      .selectFrom("files")
      .select([
        sql<
          string | number
        >`coalesce(sum(case when status='ready' then 1 else 0 end),0)`.as(
          "readyFiles",
        ),
        sql<string | number>`coalesce(sum(byte_size),0)`.as("originalBytes"),
      ])
      .where("status", "in", ["ready", "blocked"])
      .executeTakeFirstOrThrow();
    const tasks = await this.db
      .selectFrom("tasks")
      .select([
        sql<
          string | number
        >`coalesce(sum(case when status='pending' then 1 else 0 end),0)`.as(
          "pendingTasks",
        ),
        sql<
          string | number
        >`coalesce(sum(case when status='running' then 1 else 0 end),0)`.as(
          "runningTasks",
        ),
        sql<
          string | number
        >`coalesce(sum(case when status='failed' then 1 else 0 end),0)`.as(
          "failedTasks",
        ),
      ])
      .executeTakeFirstOrThrow();
    const failures = await this.db
      .selectFrom("tasks as t")
      .innerJoin("files as f", "f.id", "t.file_id")
      .select([
        "t.id",
        "t.file_id as fileId",
        "f.logical_key as logicalKey",
        "t.kind",
        "t.last_error as error",
        "t.updated_at as updatedAt",
      ])
      .where("t.status", "=", "failed")
      .orderBy("t.updated_at", "desc")
      .orderBy("t.id", "desc")
      .limit(10)
      .execute();
    return {
      readyFiles: integer(files.readyFiles),
      originalBytes: integer(files.originalBytes),
      pendingTasks: integer(tasks.pendingTasks),
      runningTasks: integer(tasks.runningTasks),
      failedTasks: integer(tasks.failedTasks),
      failures: failures.map((f) => ({
        ...f,
        updatedAt: integer(f.updatedAt),
      })),
    };
  }
  async user(id: string) {
    return this.first<User>(
      this.db.selectFrom("users").selectAll().where("id", "=", id),
    );
  }
  async userByName(name: string) {
    return this.first<User>(
      this.db.selectFrom("users").selectAll().where("username", "=", name),
    );
  }
  async owners() {
    return this.rows<User>(
      this.db
        .selectFrom("users")
        .selectAll()
        .where("role", "=", "owner")
        .limit(2),
    );
  }
  async userCount() {
    const r = await this.db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<string | number>().as("n"))
      .executeTakeFirstOrThrow();
    return integer(r.n);
  }
  private userFilter(q: string, status: string) {
    let query = this.db.selectFrom("users").where(this.contains("username", q));
    if (status) query = query.where(sql.ref("status"), "=", status);
    return query;
  }
  async users(limit: number, offset: number, q = "", status = "") {
    return this.rows<User>(
      this.userFilter(q, status)
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .offset(offset),
    );
  }
  async countUsers(q = "", status = "") {
    const r = await this.userFilter(q, status)
      .select((eb) => eb.fn.countAll<string | number>().as("n"))
      .executeTakeFirstOrThrow();
    return integer(r.n);
  }
  async updateUser(id: string, role: User["role"], status: User["status"]) {
    await this.db
      .updateTable("users")
      .set({ role, status, updated_at: Date.now() })
      .where("id", "=", id)
      .execute();
  }
  async revokeUserCredentials(id: string) {
    for (const table of ["sessions", "api_tokens"] as const)
      await this.db
        .updateTable(table)
        .set({ revoked_at: Date.now() })
        .where("user_id", "=", id)
        .where("revoked_at", "is", null)
        .execute();
  }
  async userProfiles(id: string) {
    return (await this.profilesForUsers([id])).get(id) ?? [];
  }
  async profilesForUsers(ids: string[]) {
    if (!ids.length) return new Map<string, string[]>();
    const rows = await this.db
      .selectFrom("user_upload_profiles")
      .select(["user_id", "upload_profile_id"])
      .where("user_id", "in", ids)
      .orderBy("upload_profile_id")
      .execute();
    return new Map(
      [...groupRows(rows, (r) => r.user_id)].map(([id, rows]) => [
        id,
        rows.map((r) => r.upload_profile_id),
      ]),
    );
  }
  async replaceUserProfiles(id: string, profiles: string[]) {
    await this.db
      .deleteFrom("user_upload_profiles")
      .where("user_id", "=", id)
      .execute();
    for (const profile of profiles)
      await this.db
        .insertInto("user_upload_profiles")
        .values({
          user_id: id,
          upload_profile_id: profile,
        })
        .execute();
  }
  async tokenById(id: string) {
    return this.first<Credential>(
      this.db.selectFrom("api_tokens").selectAll().where("id", "=", id),
    );
  }
  async setUserDefaultProfile(id: string, profileId: string | null) {
    await this.db
      .updateTable("users")
      .set({ default_upload_profile_id: profileId, updated_at: Date.now() })
      .where("id", "=", id)
      .execute();
  }
  async setSiteDefaultProfile(profileId: string | null) {
    await this.db
      .updateTable("upload_profiles")
      .set({
        is_default: 0,
        updated_at: Date.now(),
      })
      .where("is_default", "=", 1)
      .execute();
    if (profileId !== null)
      await this.db
        .updateTable("upload_profiles")
        .set({
          is_default: 1,
          updated_at: Date.now(),
        })
        .where("id", "=", profileId)
        .execute();
  }
  async insertUser(
    v: Omit<User, "default_upload_profile_id"> & {
      default_upload_profile_id?: string | null;
    },
  ) {
    await this.db
      .insertInto("users")
      .values(
        encode({
          ...v,
          default_upload_profile_id: v.default_upload_profile_id ?? null,
        }),
      )
      .execute();
  }
  async changePassword(id: string, version: number, hash: string) {
    const r = await this.db
      .updateTable("users")
      .set({
        password_hash: hash,
        auth_version: sql`auth_version+1`,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .where("auth_version", "=", version)
      .executeTakeFirst();
    if (r.numUpdatedRows !== 1n) throw new Conflict();
  }
  async credential(kind: "session" | "token", hash: string) {
    return this.first<Credential>(
      this.db
        .selectFrom(kind === "session" ? "sessions" : "api_tokens")
        .selectAll()
        .where("token_hash", "=", hash),
    );
  }
  async insertCredential(kind: "session" | "token", v: Credential) {
    const { auth_version, name, token_hint, allowed_profile_ids, ...common } =
      v;
    if (kind === "session") {
      if (auth_version === undefined || common.expires_at === null)
        throw new Conflict("Invalid session");
      await this.db
        .insertInto("sessions")
        .values(
          encode({ ...common, expires_at: common.expires_at, auth_version }),
        )
        .execute();
    } else {
      if (name === undefined || token_hint === undefined)
        throw new Conflict("Invalid token");
      await this.db
        .insertInto("api_tokens")
        .values(
          encode({
            ...common,
            name,
            token_hint,
            allowed_profile_ids: allowed_profile_ids ?? null,
          }),
        )
        .execute();
    }
  }
  async revokeCredential(
    kind: "session" | "token",
    id: string,
    userId: string,
  ) {
    await this.db
      .updateTable(kind === "session" ? "sessions" : "api_tokens")
      .set({ revoked_at: Date.now(), updated_at: Date.now() })
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .execute();
  }
  async tokens(id: string) {
    return this.rows<Credential>(
      this.db
        .selectFrom("api_tokens")
        .selectAll()
        .where("user_id", "=", id)
        .orderBy("created_at", "desc"),
    );
  }
  async instances(ids?: string[]) {
    if (ids && !ids.length) return [];
    let query = this.db.selectFrom("plugin_instances").selectAll();
    if (ids) query = query.where("id", "in", ids);
    return this.rows<Instance>(query);
  }
  async instanceReferences(id: string) {
    return (await this.referencesForInstances([id])).get(id) ?? [];
  }
  async referencesForInstances(ids: string[]) {
    if (!ids.length)
      return new Map<string, import("../../shared/config").Reference[]>();
    const rows = await this.db
      .selectFrom("upload_profiles")
      .select([
        sql<string>`'profile'`.as("type"),
        "id",
        "name",
        "path_instance_id as instance_id",
      ])
      .where("path_instance_id", "in", ids)
      .union(
        this.db
          .selectFrom("storage_groups as g")
          .innerJoin("storage_group_members as m", "m.group_id", "g.id")
          .select([
            sql<string>`'group'`.as("type"),
            "g.id",
            "g.name",
            "m.storage_instance_id as instance_id",
          ])
          .where("m.storage_instance_id", "in", ids),
      )
      .union(
        this.db
          .selectFrom("pipeline_steps as s")
          .innerJoin("pipelines as p", "p.id", "s.pipeline_id")
          .select([
            sql<string>`'pipeline'`.as("type"),
            "p.id",
            "p.name",
            "s.plugin_instance_id as instance_id",
          ])
          .where("s.plugin_instance_id", "in", ids),
      )
      .execute();
    return new Map(
      [...groupRows(rows, (r) => r.instance_id)].map(([id, rows]) => [
        id,
        rows.map(({ instance_id, ...reference }) => reference),
      ]),
    );
  }
  async instanceReplicaCount(id: string) {
    return (await this.replicaCounts([id])).get(id) ?? 0;
  }
  async replicaCounts(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = await this.db
      .selectFrom("file_replicas")
      .select("storage_instance_id")
      .select((eb) => eb.fn.countAll<string | number>().as("n"))
      .where("storage_instance_id", "in", ids)
      .groupBy("storage_instance_id")
      .execute();
    return new Map(rows.map((r) => [r.storage_instance_id, integer(r.n)]));
  }
  async deleteInstance(id: string) {
    await this.db.deleteFrom("plugin_instances").where("id", "=", id).execute();
  }
  async pruneTerminalReferences(id: string) {
    await this.db
      .deleteFrom("tasks")
      .where(
        "replica_id",
        "in",
        this.db
          .selectFrom("file_replicas")
          .select("id")
          .where("storage_instance_id", "=", id)
          .where("status", "=", "deleted"),
      )
      .where("status", "in", ["success", "cancelled"])
      .execute();
    await this.db
      .deleteFrom("file_replicas")
      .where("storage_instance_id", "=", id)
      .where("status", "=", "deleted")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("tasks as t")
              .select("t.id")
              .whereRef("t.replica_id", "=", "file_replicas.id"),
          ),
        ),
      )
      .execute();
  }
  async instance(id: string) {
    return this.first<Instance>(
      this.db.selectFrom("plugin_instances").selectAll().where("id", "=", id),
    );
  }
  async saveInstance(v: Instance, expected?: number) {
    if (expected === undefined)
      await this.db.insertInto("plugin_instances").values(encode(v)).execute();
    else {
      const result = await this.db
        .updateTable("plugin_instances")
        .set(encode(v))
        .where("id", "=", v.id)
        .where("config_version", "=", expected)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) throw new Conflict();
    }
  }
  async initError(id: string, error: string | null) {
    await this.db
      .updateTable("plugin_instances")
      .set({ last_init_error: error, updated_at: Date.now() })
      .where("id", "=", id)
      .execute();
  }
  async updateSecrets(id: string, value: string, version: number) {
    const r = await this.db
      .updateTable("plugin_instances")
      .set({
        secrets_encrypted: value,
        secrets_version: sql`secrets_version+1`,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .where("secrets_version", "=", version)
      .executeTakeFirst();
    if (r.numUpdatedRows !== 1n) throw new Conflict();
  }
  async updateState(id: string, value: Config, version: number) {
    const r = await this.db
      .updateTable("plugin_instances")
      .set({
        state_json: JSON.stringify(value),
        state_version: sql`state_version+1`,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .where("state_version", "=", version)
      .executeTakeFirst();
    if (r.numUpdatedRows !== 1n) throw new Conflict();
  }
  async group(id: string) {
    return this.first<Group>(
      this.db.selectFrom("storage_groups").selectAll().where("id", "=", id),
    );
  }
  async groups() {
    return this.rows<Group>(
      this.db
        .selectFrom("storage_groups")
        .selectAll()
        .orderBy("created_at")
        .orderBy("id"),
    );
  }
  async saveGroup(v: Group, expected: number) {
    const result = await this.db
      .updateTable("storage_groups")
      .set(encode(v))
      .where("id", "=", v.id)
      .where("config_version", "=", expected)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async replaceMembers(
    id: string,
    members: Array<{ instanceId: string; weight: number }>,
  ) {
    await this.db
      .deleteFrom("storage_group_members")
      .where("group_id", "=", id)
      .execute();
    for (const [n, m] of members.entries())
      await this.insertMember(id, m.instanceId, n, m.weight);
  }
  async deleteGroup(id: string) {
    await this.db
      .deleteFrom("storage_group_members")
      .where("group_id", "=", id)
      .execute();
    await this.db.deleteFrom("storage_groups").where("id", "=", id).execute();
  }
  async members(id: string) {
    return (await this.membersForGroups([id])).get(id) ?? [];
  }
  async membersForGroups(ids: string[]) {
    if (!ids.length)
      return new Map<
        string,
        Array<{ storage_instance_id: string; priority: number; weight: number }>
      >();
    const rows = await this.db
      .selectFrom("storage_group_members")
      .select(["group_id", "storage_instance_id", "priority", "weight"])
      .where("group_id", "in", ids)
      .orderBy("priority")
      .execute();
    return new Map(
      [...groupRows(rows, (r) => r.group_id)].map(([id, rows]) => [
        id,
        rows.map(({ group_id, ...m }) => ({
          ...m,
          priority: integer(m.priority),
        })),
      ]),
    );
  }
  async insertGroup(v: Group) {
    await this.db.insertInto("storage_groups").values(encode(v)).execute();
  }
  async insertMember(
    group_id: string,
    storage_instance_id: string,
    priority: number,
    weight: number,
  ) {
    if ((await this.instance(storage_instance_id))?.kind !== "storage")
      throw new Conflict("Expected storage instance");
    await this.db
      .insertInto("storage_group_members")
      .values({
        group_id,
        storage_instance_id,
        priority: integer(priority),
        weight,
      })
      .execute();
  }
  async profile(id: string) {
    return this.first<Profile>(
      this.db.selectFrom("upload_profiles").selectAll().where("id", "=", id),
    );
  }
  async profiles() {
    return this.rows<Profile>(
      this.db.selectFrom("upload_profiles").selectAll(),
    );
  }
  async insertProfile(
    v: Omit<Profile, "is_default"> & { is_default?: boolean },
  ) {
    if ((await this.instance(v.path_instance_id))?.kind !== "path")
      throw new Conflict("Expected path instance");
    await this.db
      .insertInto("upload_profiles")
      .values(encode({ ...v, is_default: v.is_default ?? false }))
      .execute();
  }
  async saveProfile(v: Profile, expected: number) {
    // Defaults are independent of upload rules and may change during an edit.
    const { is_default: _default, ...configuration } = v;
    const result = await this.db
      .updateTable("upload_profiles")
      .set(encode(configuration))
      .where("id", "=", v.id)
      .where("config_version", "=", expected)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async deleteProfile(id: string) {
    await this.db.deleteFrom("upload_profiles").where("id", "=", id).execute();
  }
  async pipelines() {
    return this.rows<Pipeline>(
      this.db
        .selectFrom("pipelines")
        .selectAll()
        .orderBy("created_at")
        .orderBy("id"),
    );
  }
  async pipeline(id: string) {
    return this.first<Pipeline>(
      this.db.selectFrom("pipelines").selectAll().where("id", "=", id),
    );
  }
  async accessPipeline() {
    return this.first<Pipeline>(
      this.db.selectFrom("pipelines").selectAll().where("kind", "=", "access"),
    );
  }
  async insertPipeline(v: Pipeline) {
    await this.db.insertInto("pipelines").values(encode(v)).execute();
  }
  async savePipeline(v: Pipeline, expected: number) {
    const result = await this.db
      .updateTable("pipelines")
      .set(encode(v))
      .where("id", "=", v.id)
      .where("config_version", "=", expected)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async deletePipeline(id: string) {
    await this.db.deleteFrom("pipelines").where("id", "=", id).execute();
  }
  async replaceSteps(id: string, steps: Step[]) {
    const pipeline = await this.pipeline(id);
    await this.db
      .deleteFrom("pipeline_steps")
      .where("pipeline_id", "=", id)
      .execute();
    for (const s of steps) {
      if (s.pipeline_id !== id) throw new Conflict("Invalid pipeline owner");
      await this.insertPipelineStep(s, pipeline);
    }
  }
  async steps(id: string) {
    return (await this.stepsForPipelines([id])).get(id) ?? [];
  }
  async stepsForPipelines(ids: string[]) {
    if (!ids.length) return new Map<string, Step[]>();
    const rows = await this.rows<Step>(
      this.db
        .selectFrom("pipeline_steps")
        .selectAll()
        .where("pipeline_id", "in", ids)
        .orderBy("position"),
    );
    return groupRows(rows, (r) => r.pipeline_id);
  }
  async insertStep(v: Step) {
    await this.insertPipelineStep(v, await this.pipeline(v.pipeline_id));
  }
  private async insertPipelineStep(v: Step, p: Pipeline | null) {
    const i = await this.instance(v.plugin_instance_id);
    if (
      !p ||
      i?.kind !== "processor" ||
      (p.kind === "post_save"
        ? v.on_not_applicable !== null
        : v.on_not_applicable === null)
    )
      throw new Conflict("Invalid step kind or policy");
    if (i.stage !== p.kind) throw new Conflict("Invalid step stage");
    await this.db.insertInto("pipeline_steps").values(encode(v)).execute();
  }
  async prefixes() {
    return (
      await this.db
        .selectFrom("files")
        .select("public_prefix")
        .union(this.db.selectFrom("upload_profiles").select("public_prefix"))
        .execute()
    ).map((x) => x.public_prefix);
  }
  async file(id: string) {
    return this.first<FileRecord>(
      this.db.selectFrom("files").selectAll().where("id", "=", id),
    );
  }
  async objectRegistered(
    instanceId: string,
    storageKey: string,
    locator: Locator,
  ) {
    if (locator === null) {
      const found = await this.db
        .selectFrom("files as f")
        .select("f.id")
        .where("f.storage_key", "=", storageKey)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("file_replicas as r")
              .select("r.id")
              .whereRef("r.file_id", "=", "f.id")
              .where("r.storage_instance_id", "=", instanceId)
              .where("r.status", "!=", "deleted")
              .where("r.locator_json", "is", null),
          ),
        )
        .limit(1)
        .executeTakeFirst();
      return !!found;
    }
    const candidates = await this.rows<{ locator_json: Locator }>(
      this.db
        .selectFrom("file_replicas as r")
        .select("r.locator_json")
        .where("r.storage_instance_id", "=", instanceId)
        .where("r.status", "!=", "deleted")
        .where("r.locator_json", "is not", null),
    );
    return candidates.some((c) => isDeepStrictEqual(c.locator_json, locator));
  }
  async fileByPath(path: string) {
    return this.first<FileRecord>(
      this.db.selectFrom("files").selectAll().where("public_path", "=", path),
    );
  }
  private fileFilter(filter: FileFilter = {}) {
    let q = this.db.selectFrom("files");
    if (filter.storageInstanceId)
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom("file_replicas as r")
            .select("r.id")
            .whereRef("r.file_id", "=", "files.id")
            .where("r.storage_instance_id", "=", filter.storageInstanceId!)
            .where("r.status", "!=", "deleted"),
        ),
      );
    if (filter.ownerId !== undefined)
      q = q.where(
        "owner_id",
        filter.ownerId === null ? "is" : "=",
        filter.ownerId,
      );
    if (filter.createdFrom !== undefined)
      q = q.where("created_at", ">=", filter.createdFrom);
    if (filter.createdBefore !== undefined)
      q = q.where("created_at", "<", filter.createdBefore);
    if (filter.status) q = q.where("status", "=", filter.status);
    if (filter.mimeType) q = q.where("mime_type", "=", filter.mimeType);
    if (filter.q)
      q = q.where((eb) =>
        eb.or([
          this.contains("id", filter.q!),
          this.contains("logical_key", filter.q!),
        ]),
      );
    return q;
  }
  async files(limit: number, offset: number, filter?: FileFilter) {
    return this.rows<FileRecord>(
      this.fileFilter(filter)
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .offset(offset),
    );
  }
  async pendingFileDeletions(fileIds: string[]) {
    if (!fileIds.length) return [];
    const rows = await this.db
      .selectFrom("tasks")
      .select("file_id")
      .distinct()
      .where("file_id", "in", fileIds)
      .where("kind", "=", "delete")
      .where("status", "in", ["pending", "running"])
      .execute();
    return rows.map((row) => row.file_id);
  }
  async failedFileDeletions(fileIds: string[]) {
    if (!fileIds.length) return [];
    const rows = await this.db
      .selectFrom("files")
      .select("id")
      .where("id", "in", fileIds)
      .where("status", "=", "deleting")
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("tasks")
              .select("id")
              .whereRef("tasks.file_id", "=", "files.id")
              .where("status", "in", ["pending", "running"]),
          ),
        ),
      )
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom("tasks")
              .select("id")
              .whereRef("tasks.file_id", "=", "files.id")
              .where("kind", "=", "delete")
              .where("status", "=", "failed"),
          ),
          eb.exists(
            eb
              .selectFrom("file_replicas")
              .select("id")
              .whereRef("file_replicas.file_id", "=", "files.id")
              .where("status", "=", "write_unknown"),
          ),
        ]),
      )
      .execute();
    return rows.map((row) => row.id);
  }
  async removeFile(id: string) {
    // Called in a transaction after all work for this file has stopped.
    await this.db.deleteFrom("tasks").where("file_id", "=", id).execute();
    await this.db
      .deleteFrom("file_replicas")
      .where("file_id", "=", id)
      .execute();
    await this.db.deleteFrom("files").where("id", "=", id).execute();
  }
  async countFiles(filter?: FileFilter) {
    const r = await this.fileFilter(filter)
      .select((eb) => eb.fn.countAll<string | number>().as("n"))
      .executeTakeFirstOrThrow();
    return integer(r.n);
  }
  async filesInStates(states: FileRecord["status"][]) {
    if (!states.length) return [];
    return this.rows<FileRecord>(
      this.db.selectFrom("files").selectAll().where("status", "in", states),
    );
  }
  async insertFile(v: FileRecord) {
    if (!(await this.insertFileIfPathFree(v)))
      throw new Conflict("Public path already exists");
  }
  async insertFileIfPathFree(v: FileRecord) {
    const result = await this.db
      .insertInto("files")
      .values({
        ...encode(v),
        public_path: publicPathKey(publicPath(v.public_prefix, v.logical_key)),
      })
      .onConflict((oc) => oc.column("public_path").doNothing())
      .executeTakeFirstOrThrow();
    return result.numInsertedOrUpdatedRows === 1n;
  }
  async filesNeedingCleanup() {
    return this.rows<FileRecord>(
      this.db
        .selectFrom("files")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb("status", "in", ["failed", "deleting"]),
            eb.and([
              eb("status", "in", ["ready", "blocked"]),
              eb("temp_path", "is not", null),
            ]),
          ]),
        )
        // Preserve cleanup's existing priority over temporary-source removal.
        .orderBy(
          sql`case when status in ('failed', 'deleting') then 0 else 1 end`,
        ),
    );
  }
  async fillFileMetadata(
    id: string,
    m: Pick<FileRecord, "mime_type" | "byte_size" | "width" | "height">,
  ) {
    m = encode(m);
    await this.db
      .updateTable("files")
      .set({
        mime_type: sql`coalesce(mime_type,${m.mime_type})`,
        byte_size: sql`coalesce(byte_size,${m.byte_size})`,
        width: sql`coalesce(width,${m.width})`,
        height: sql`coalesce(height,${m.height})`,
        updated_at: Date.now(),
      })
      .where("id", "=", id)
      .where("status", "in", ["ready", "blocked"])
      .where((eb) =>
        eb.or([
          eb("mime_type", "is", null),
          eb("byte_size", "is", null),
          eb("width", "is", null),
          eb("height", "is", null),
        ]),
      )
      .execute();
  }
  async saveFile(v: FileRecord, expected: FileRecord["status"]) {
    const result = await this.db
      .updateTable("files")
      .set(
        encode({
          ...v,
          public_path: publicPathKey(
            publicPath(v.public_prefix, v.logical_key),
          ),
          updated_at: Date.now(),
        }),
      )
      .where("id", "=", v.id)
      .where("status", "=", expected)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async replicas(id: string) {
    return this.rows<Replica>(
      this.db.selectFrom("file_replicas").selectAll().where("file_id", "=", id),
    );
  }
  async replica(id: string) {
    return this.first<Replica>(
      this.db.selectFrom("file_replicas").selectAll().where("id", "=", id),
    );
  }
  async insertReplica(v: Replica) {
    if ((await this.instance(v.storage_instance_id))?.kind !== "storage")
      throw new Conflict("Expected storage instance");
    await this.db.insertInto("file_replicas").values(encode(v)).execute();
  }
  async saveReplica(v: Replica) {
    const result = await this.db
      .updateTable("file_replicas")
      .set(encode({ ...v, updated_at: Date.now() }))
      .where("id", "=", v.id)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async tasks(id: string) {
    return this.rows<Task>(
      this.db
        .selectFrom("tasks")
        .selectAll()
        .where("file_id", "=", id)
        .orderBy("created_at")
        .orderBy("id"),
    );
  }
  async task(id: string) {
    return this.first<Task>(
      this.db.selectFrom("tasks").selectAll().where("id", "=", id),
    );
  }
  async insertTask(v: Task) {
    if (
      v.kind === "action" &&
      (await this.pipeline(v.pipeline_id!))?.kind !== "post_save"
    )
      throw new Conflict("Expected post-save pipeline");
    await this.db.insertInto("tasks").values(encode(v)).execute();
  }
  async saveTask(v: Task, expected?: Task["status"]) {
    let query = this.db
      .updateTable("tasks")
      .set(encode({ ...v, updated_at: Date.now() }))
      .where("id", "=", v.id);
    if (expected) query = query.where("status", "=", expected);
    const result = await query.executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new Conflict();
  }
  async dueTasks(
    now: number,
    options?: {
      limit: number;
      excludedFiles: string[];
      excludedTasks: string[];
    },
  ) {
    let query = this.db
      .selectFrom("tasks")
      .selectAll()
      .where("status", "=", "pending")
      .where("next_run_at", "<=", now)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("files")
            .select("files.id")
            .whereRef("files.id", "=", "tasks.file_id")
            .where((eb) =>
              eb.or([
                eb.and([
                  eb("tasks.kind", "=", "write"),
                  eb("files.status", "in", ["ready", "blocked"]),
                ]),
                eb.and([
                  eb("tasks.kind", "=", "action"),
                  eb("files.status", "=", "ready"),
                ]),
                eb.and([
                  eb("tasks.kind", "=", "delete"),
                  eb("files.status", "in", ["ready", "blocked", "deleting"]),
                ]),
              ]),
            ),
        ),
      );
    if (options?.excludedFiles.length)
      query = query.where("file_id", "not in", options.excludedFiles);
    if (options?.excludedTasks.length)
      query = query.where("id", "not in", options.excludedTasks);
    return this.rows<Task>(
      query
        .orderBy("next_run_at")
        .orderBy("created_at")
        .orderBy("id")
        .limit(options?.limit ?? 50),
    );
  }
  async recoverTasks() {
    await this.db
      .updateTable("tasks")
      .set({
        status: "failed",
        next_run_at: null,
        last_error: "INTERRUPTED_TASK",
      })
      .where("status", "=", "running")
      .where("manual_retry", "=", 1)
      .execute();
    await this.db
      .updateTable("tasks")
      .set({ status: "pending", next_run_at: Date.now() })
      .where("status", "=", "running")
      .execute();
  }
}
