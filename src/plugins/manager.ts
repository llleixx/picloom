import { assertLocalDirectory, directoryRoot } from "./local-directory";
import sharp from "sharp";
import { assertParamsSchema } from "../../shared/params-schema";
import { assertPluginContent } from "../../shared/plugin-localization";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError, Conflict, requireValue } from "../core/errors";
import { Mutex } from "../core/concurrency";
import { Secrets } from "../infra/secrets";
import { safePath } from "../infra/files";
import { parseManifest } from "./archive";
import type { Persistence, Instance } from "../persistence/port";
import { entity } from "../persistence/port";
import {
  assertSchema,
  assertUIHints,
  pointer,
  sensitivePaths,
  readPointer,
  writePointer,
  type SecretEdit,
  type UpgradeIntent,
  type UpgradePreview,
} from "../../shared/config";
import type {
  Config,
  Definition,
  Kind,
  Runtimes,
  Runtime,
  InstanceServices,
  Json,
  Stage,
  Descriptor,
} from "./api";
interface Slot {
  record: Instance;
  runtime: Runtime;
  refs: number;
  retired: boolean;
  disposed: boolean;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function hasSensitive(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value) && (value as Config)["x-sensitive"] === true)
    return true;
  return Object.values(value).some(hasSensitive);
}
function normalizeSchema(schema: Config): Config {
  const result = structuredClone(schema);
  if (result.type === "object" && result.additionalProperties === undefined)
    result.additionalProperties = false;
  const properties = result.properties as Record<string, Config> | undefined;
  if (properties)
    for (const key of Object.keys(properties))
      properties[key] = normalizeSchema(properties[key]!);
  if (
    result.items &&
    typeof result.items === "object" &&
    !Array.isArray(result.items)
  )
    result.items = normalizeSchema(result.items as Config);
  return result;
}
function split(
  value: Config,
  schema: Config,
): { config: Config; secrets: Config } {
  const config: Config = {},
    secrets: Config = {};
  const props = (schema.properties ?? {}) as Record<string, Config>;
  for (const [key, val] of Object.entries(value)) {
    const rule = props[key] ?? {};
    if (rule["x-sensitive"] === true) secrets[key] = val;
    else if (
      rule.type === "object" &&
      val &&
      typeof val === "object" &&
      !Array.isArray(val)
    ) {
      const nested = split(val as Config, rule);
      config[key] = nested.config;
      if (Object.keys(nested.secrets).length) secrets[key] = nested.secrets;
    } else if (hasSensitive(rule)) secrets[key] = val;
    else config[key] = val;
  }
  return { config, secrets };
}
export function mergeConfig(a: Config, b: Config): Config {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    )
      out[k] = mergeConfig(out[k] as Config, v as Config);
    else out[k] = structuredClone(v);
  }
  return out;
}
export class PluginManager {
  private definitions = new Map<string, Definition>();
  private builtins = new Set<string>();
  private slots = new Map<string, Slot>();
  private retired = new Set<Slot>();
  private mutex = new Mutex();
  private ajv = new Ajv2020({
    allErrors: true,
    useDefaults: false,
    strict: false,
  });
  constructor(
    private db: Persistence,
    private secrets: Secrets,
    private dataRoot: string,
  ) {
    addFormats(this.ajv);
    this.ajv.addKeyword({
      keyword: "x-sensitive",
      schemaType: "boolean",
      valid: true,
    });
    this.ajv.addKeyword({
      keyword: "x-enumLabels",
      schemaType: "array",
      valid: true,
    });
    this.ajv.addKeyword({
      keyword: "x-immutable",
      schemaType: "boolean",
      valid: true,
    });
  }
  register(def: Definition, source: "builtin" | "external" = "builtin") {
    try {
      if (
        !def.id ||
        !def.version ||
        def.apiVersion !== 1 ||
        !["path", "storage", "processor"].includes(def.kind)
      )
        throw new Error("Invalid identity");
      assertLocalDirectory(def);
      const descriptions =
        def.kind === "processor"
          ? Object.entries(def.stages ?? {})
          : [[null, def] as const];
      if (!descriptions.length) throw new Error("No stages");
      if (def.kind === "processor")
        assertPluginContent(def, { type: "object" }, {}, undefined, true);
      for (const [stage, desc] of descriptions) {
        if (
          stage !== null &&
          !["upload", "access", "post_save"].includes(stage)
        )
          throw new Error("Unknown stage");
        if (
          !desc ||
          typeof desc.createInstance !== "function" ||
          (desc.migrateConfig !== undefined &&
            typeof desc.migrateConfig !== "function") ||
          !Number.isInteger(desc.configSchemaVersion) ||
          desc.configSchemaVersion < 1
        )
          throw new Error("Invalid stage");
        desc.configSchema = normalizeSchema(desc.configSchema);
        if (
          desc.configSchema.type !== "object" ||
          desc.configSchema["x-sensitive"]
        )
          throw new Error("Invalid configuration root");
        assertSchema(desc.configSchema);
        if (desc.uiHints) assertUIHints(desc.uiHints);
        assertPluginContent(
          desc,
          desc.configSchema,
          desc.uiHints ?? {},
          "paramsSchema" in desc ? (desc.paramsSchema as Config) : undefined,
          stage === null,
        );
        this.ajv.compile(desc.configSchema);
        if ("paramsSchema" in desc && desc.paramsSchema !== undefined) {
          if (stage !== "access" && stage !== "upload")
            throw new Error(
              "Request parameters require upload or access stage",
            );
          assertParamsSchema(desc.paramsSchema as Config);
          this.ajv.compile(desc.paramsSchema as Config);
        }
      }
    } catch {
      throw new AppError(
        "PLUGIN_INVALID",
        "Invalid plugin or stage description",
      );
    }
    const k = def.id + "@" + def.version;
    if (this.definitions.has(k))
      throw new Conflict("Plugin version already loaded");
    this.definitions.set(k, def);
    if (source === "builtin") this.builtins.add(k);
  }
  async loadPackage(directory: string) {
    const manifest = parseManifest(
      JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")),
    );
    if (manifest.apiVersion !== 1)
      throw new AppError("PLUGIN_VERSION", "Incompatible API version");
    const entry = await safePath(directory, manifest.entry);
    const module = await import(
      pathToFileURL(entry).href + "?load=" + crypto.randomUUID()
    );
    const def = module.default as Definition;
    if (
      def.id !== manifest.id ||
      def.version !== manifest.version ||
      def.kind !== manifest.kind
    )
      throw new AppError("PLUGIN_INVALID", "Manifest does not match module");
    this.register(def, "external");
    return def;
  }
  exclusive<T>(work: () => Promise<T>) {
    return this.mutex.run(work);
  }
  async initializePackageInstances(id: string, version: string) {
    for (const instance of await this.db.read((r) => r.instances()))
      if (instance.plugin_id === id && instance.plugin_version === version)
        await this.initialize(instance);
  }
  isBuiltin(id: string, version: string) {
    return this.builtins.has(id + "@" + version);
  }
  async assertPackageUnused(id: string, version: string) {
    if (this.isBuiltin(id, version))
      throw new AppError("PLUGIN_BUILTIN", "内置插件不可卸载", 409);
    const instances = (await this.db.read((r) => r.instances())).filter(
      (i) => i.plugin_id === id && i.plugin_version === version,
    );
    if (instances.length)
      throw new Conflict(
        "请先处理并删除插件实例：" +
          instances
            .slice(0, 5)
            .map((i) => i.name)
            .join("、"),
      );
    if (
      [...this.slots.values(), ...this.retired].some(
        (s) =>
          s.record.plugin_id === id &&
          s.record.plugin_version === version &&
          s.refs > 0,
      )
    )
      throw new Conflict("插件仍有在途调用或文件流");
  }
  forgetPackage(id: string, version: string) {
    if (this.isBuiltin(id, version))
      throw new AppError("PLUGIN_BUILTIN", "内置插件不可卸载", 409);
    this.definitions.delete(id + "@" + version);
  }
  definition(record: Pick<Instance, "plugin_id" | "plugin_version">) {
    return requireValue(
      this.definitions.get(record.plugin_id + "@" + record.plugin_version),
      "Plugin is not loaded",
    );
  }
  descriptor(record: Pick<Instance, "plugin_id" | "plugin_version" | "stage">) {
    const root = this.definition(record);
    if (root.kind !== "processor") {
      if (record.stage)
        throw new AppError("CONFIG_INVALID", "Unexpected stage");
      return { ...root, paramsSchema: undefined as Config | undefined };
    }
    const stage = record.stage && root.stages[record.stage];
    if (!stage)
      throw new AppError("CONFIG_INVALID", "Unsupported processor stage");
    return {
      ...root,
      ...stage,
      paramsSchema:
        "paramsSchema" in stage
          ? (stage.paramsSchema as Config | undefined)
          : undefined,
    };
  }
  localDirectory(
    record: Instance,
  ): { id: string; root: string; configPath: string } | null {
    if (record.kind !== "storage") return null;
    const def = this.definition(record);
    if (def.kind !== "storage" || !def.localDirectory) return null;
    const configPath = def.localDirectory.configPath;
    return {
      id: record.id,
      root: directoryRoot(record.config_json, configPath),
      configPath,
    };
  }
  private services(id: string): InstanceServices {
    return {
      images: { sharp },
      log(event) {
        console.info(
          JSON.stringify({ event: event.slice(0, 120), instanceId: id }),
        );
      },
      readSecrets: async () => {
        const r = requireValue(await this.db.read((x) => x.instance(id)));
        return {
          value: this.secrets.decrypt(r.secrets_encrypted, id),
          version: r.secrets_version,
        };
      },
      updateSecrets: async (value, version) => {
        await this.db.transaction((x) =>
          x.updateSecrets(id, this.secrets.encrypt(value, id), version),
        );
      },
      readState: async () => {
        const r = requireValue(await this.db.read((x) => x.instance(id)));
        return { value: r.state_json, version: r.state_version };
      },
      updateState: async (value, version) => {
        await this.db.transaction((x) => x.updateState(id, value, version));
      },
    };
  }
  private async dispose(slot: Slot) {
    if (slot.retired && slot.refs === 0 && !slot.disposed) {
      slot.disposed = true;
      try {
        await slot.runtime.dispose?.();
      } catch {
        console.error(
          JSON.stringify({
            event: "plugin_dispose_failed",
            instanceId: slot.record.id,
          }),
        );
      } finally {
        this.retired.delete(slot);
      }
    }
  }
  async retire(id: string) {
    const slot = this.slots.get(id);
    if (slot) {
      this.slots.delete(id);
      slot.retired = true;
      this.retired.add(slot);
      await this.dispose(slot);
    }
  }
  private async initialize(record: Instance) {
    try {
      const def = this.descriptor(record);
      if (record.config_schema_version !== def.configSchemaVersion)
        throw new Error("Incompatible config");
      const runtime = await def.createInstance({
        id: record.id,
        config: freeze(structuredClone(record.config_json)),
        services: this.services(record.id),
      });
      const required = {
        path: ["generate"],
        storage: ["write", "read", "delete"],
        processor:
          record.stage === "post_save" ? ["execute"] : ["check", "process"],
      }[record.kind];
      if (
        required.some(
          (k) =>
            typeof (runtime as unknown as Record<string, unknown>)[k] !==
            "function",
        )
      ) {
        await runtime.dispose?.();
        throw new Error("Missing method");
      }
      this.slots.set(record.id, {
        record,
        runtime,
        refs: 0,
        retired: false,
        disposed: false,
      });
      await this.db.transaction((x) => x.initError(record.id, null));
      return true;
    } catch {
      await this.db.transaction((x) =>
        x.initError(
          record.id,
          "Plugin initialization failed; check configuration and credentials",
        ),
      );
      return false;
    }
  }
  async start() {
    for (const record of await this.db.read((x) => x.instances()))
      await this.initialize(record);
  }
  private applyDefaults(schema: Config, value: Config) {
    for (const [key, rule] of Object.entries(
      (schema.properties ?? {}) as Record<string, Config>,
    )) {
      if (value[key] === undefined && rule.default !== undefined)
        value[key] = structuredClone(rule.default);
      if (rule.type === "object") {
        const nested = value[key] === undefined ? {} : value[key];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          this.applyDefaults(rule, nested as Config);
          if (Object.keys(nested).length) value[key] = nested;
        }
      }
      if (rule.type === "array" && Array.isArray(value[key]) && rule.items)
        for (const item of value[key] as Json[])
          if (item && typeof item === "object" && !Array.isArray(item))
            this.applyDefaults(rule.items as Config, item as Config);
    }
    for (const clause of (schema.allOf ?? []) as Config[])
      this.applyDefaults(clause, value);
    if (schema.if) {
      const branch = this.ajv.compile(schema.if as Config)(value)
        ? schema.then
        : schema.else;
      if (branch) this.applyDefaults(branch as Config, value);
    }
  }
  private upgradeTarget(old: Instance, version: string) {
    if (
      this.isBuiltin(old.plugin_id, old.plugin_version) ||
      this.isBuiltin(old.plugin_id, version)
    )
      throw new AppError(
        "PLUGIN_UPGRADE_UNSUPPORTED",
        "Built-in plugins are updated with the server",
        400,
      );
    const target = this.descriptor({ ...old, plugin_version: version });
    if (target.kind !== old.kind || version === old.plugin_version)
      throw new AppError(
        "CONFIG_INVALID",
        "Choose a different version of the same plugin",
      );
    return target;
  }
  async previewUpgrade(id: string, version: string): Promise<UpgradePreview> {
    const old = requireValue(await this.db.read((r) => r.instance(id)));
    const target = this.upgradeTarget(old, version);
    const full = structuredClone(old.config_json);
    const secrets = this.secrets.decrypt(old.secrets_encrypted, id);
    for (const path of sensitivePaths(this.descriptor(old).configSchema))
      writePointer(full, path, readPointer(secrets, path));
    let migrated: Config;
    try {
      migrated = target.migrateConfig
        ? await target.migrateConfig({
            from: {
              pluginVersion: old.plugin_version,
              configSchemaVersion: old.config_schema_version,
            },
            apiVersion: 1,
            config: full,
          })
        : full;
      if (!migrated || typeof migrated !== "object" || Array.isArray(migrated))
        throw new Error();
      migrated = JSON.parse(JSON.stringify(migrated));
    } catch {
      throw new AppError(
        "PLUGIN_MIGRATION_FAILED",
        "Configuration migration failed",
        400,
      );
    }
    this.applyDefaults(target.configSchema, migrated);
    const validate = this.ajv.compile(target.configSchema);
    validate(migrated);
    const fields = (validate.errors ?? []).map((e) => ({
      path:
        e.instancePath +
        (e.keyword === "required" ? "/" + e.params.missingProperty : ""),
      message: e.message ?? "Invalid field",
    }));
    const parts = split(migrated, target.configSchema);
    const secretEdits: Record<string, SecretEdit> = {};
    for (const path of sensitivePaths(target.configSchema)) {
      const value = readPointer(parts.secrets, path);
      secretEdits[path] =
        value === undefined
          ? { action: "clear" }
          : { action: "replace", value };
    }
    return {
      fields,
      configuration: {
        key: id,
        pluginId: old.plugin_id,
        version,
        config: parts.config,
        secretEdits,
        upgrade: {
          fromVersion: old.plugin_version,
          configVersion: old.config_version,
          secretsVersion: old.secrets_version,
        },
      },
    };
  }
  async prepareCopy(id: string) {
    const old = requireValue(await this.db.read((r) => r.instance(id)));
    const secrets = this.secrets.decrypt(old.secrets_encrypted, id);
    return this.prepare({
      stage: old.stage ?? undefined,
      pluginId: old.plugin_id,
      version: old.plugin_version,
      name: old.name,
      config: structuredClone(old.config_json),
      secretEdits: Object.fromEntries(
        sensitivePaths(this.descriptor(old).configSchema).flatMap((path) => {
          const value = readPointer(secrets, path);
          return value === undefined
            ? []
            : [[path, { action: "replace" as const, value }]];
        }),
      ),
    });
  }
  async prepare(input: {
    id?: string;
    stage?: Stage;
    pluginId: string;
    version: string;
    name: string;
    config: Config;
    maxStorageBytes?: number | null;
    expectedVersion?: number;
    secretEdits?: Record<string, SecretEdit>;
    upgrade?: UpgradeIntent;
  }) {
    const old = input.id
      ? requireValue(await this.db.read((x) => x.instance(input.id!)))
      : null;
    if (
      old &&
      (input.expectedVersion !== old.config_version ||
        old.plugin_id !== input.pluginId ||
        (old.plugin_version !== input.version && !input.upgrade) ||
        old.stage !== (input.stage ?? null))
    )
      throw new Conflict();
    const def = this.descriptor({
      plugin_id: input.pluginId,
      plugin_version: input.version,
      stage: input.stage ?? null,
    });
    if (input.upgrade) {
      if (
        !old ||
        old.plugin_version === input.version ||
        input.upgrade.fromVersion !== old.plugin_version ||
        input.upgrade.configVersion !== old.config_version ||
        input.upgrade.secretsVersion !== old.secrets_version
      )
        throw new Conflict();
      this.upgradeTarget(old, input.version);
    }
    const full = structuredClone(input.config);
    const previous = old
      ? this.secrets.decrypt(old.secrets_encrypted, old.id)
      : {};
    const paths = sensitivePaths(def.configSchema);
    if (Object.keys(input.secretEdits ?? {}).some((p) => !paths.includes(p)))
      throw new AppError("CONFIG_INVALID", "Unknown sensitive field");
    for (const path of paths) {
      writePointer(full, path, undefined);
      const edit = input.secretEdits?.[path] ?? { action: "preserve" };
      if (!edit || !["preserve", "replace", "clear"].includes(edit.action))
        throw new AppError(
          "CONFIG_INVALID",
          "Invalid sensitive field operation",
        );
      const value =
        edit.action === "replace"
          ? edit.value
          : edit.action === "preserve"
            ? readPointer(previous, path)
            : undefined;
      writePointer(full, path, value);
    }
    if (!input.name?.trim() || input.name.length > 100)
      throw new AppError("CONFIG_INVALID", "实例名称须为 1–100 字符");
    this.applyDefaults(def.configSchema, full);
    const validate = this.ajv.compile(def.configSchema);
    if (!validate(full))
      throw new AppError(
        "CONFIG_INVALID",
        "Configuration does not match plugin schema",
        400,
        validate.errors?.map((e) => ({
          path:
            e.instancePath +
            (e.keyword === "required" ? "/" + e.params.missingProperty : ""),
          message: e.message ?? "Invalid field",
        })),
      );
    if ("localDirectory" in def && def.localDirectory) {
      try {
        const path = def.localDirectory.configPath;
        const value = readPointer(full, path);
        if (typeof value !== "string" || !value.trim()) throw new Error();
        writePointer(full, path, resolve(this.dataRoot, value));
        directoryRoot(full, path);
      } catch {
        throw new AppError(
          "CONFIG_INVALID",
          "Local directory must be a non-empty path",
        );
      }
    }
    if (def.validateConfig) {
      const errors = await def.validateConfig(freeze(structuredClone(full)));
      if (errors.length)
        throw new AppError(
          "CONFIG_INVALID",
          "Plugin rejected configuration",
          400,
          errors.map((e) => ({
            path: e.path ?? "",
            message: "Field does not meet plugin requirements.",
          })),
        );
    }
    const parts = split(full, def.configSchema);
    if (old) {
      const check = (rule: Config, path: string) => {
        if (
          rule["x-immutable"] &&
          (!input.upgrade ||
            readPointer(old.config_json, path) !== undefined) &&
          JSON.stringify(readPointer(old.config_json, path)) !==
            JSON.stringify(readPointer(parts.config, path))
        )
          throw new AppError(
            "NEW_INSTANCE_REQUIRED",
            "存储目标变化需要创建新实例",
          );
        for (const [key, child] of Object.entries(
          (rule.properties ?? {}) as Record<string, Config>,
        ))
          check(child, path + "/" + pointer(key));
      };
      check(def.configSchema, "");
      if (input.upgrade) check(this.descriptor(old).configSchema, "");
    }
    const maxStorageBytes =
      input.maxStorageBytes === undefined
        ? (old?.max_storage_bytes ?? null)
        : input.maxStorageBytes;
    if (
      maxStorageBytes !== null &&
      (def.kind !== "storage" ||
        !Number.isSafeInteger(maxStorageBytes) ||
        maxStorageBytes <= 0)
    )
      throw new AppError(
        "CONFIG_INVALID",
        "Storage capacity must be a positive integer",
      );
    const record: Instance = {
      ...(old ?? entity()),
      max_storage_bytes: maxStorageBytes,
      plugin_id: def.id,
      plugin_version: def.version,
      kind: def.kind,
      stage: input.stage ?? null,
      name: input.name,
      config_json: parts.config,
      config_version: (old?.config_version ?? 0) + 1,
      config_schema_version: def.configSchemaVersion,
      secrets_encrypted: null,
      secrets_version: (old?.secrets_version ?? 0) + 1,
      state_json: old?.state_json ?? {},
      state_version: old?.state_version ?? 1,
      last_init_error: null,
      updated_at: Date.now(),
    };
    record.secrets_encrypted = this.secrets.encrypt(parts.secrets, record.id);

    return { record, old };
  }
  async persistPrepared(
    x: import("../persistence/port").Repositories,
    prepared: Awaited<ReturnType<PluginManager["prepare"]>>,
  ) {
    const { record, old } = prepared;
    if (old) {
      const current = requireValue(await x.instance(old.id));
      if (current.secrets_version !== old.secrets_version) throw new Conflict();
      record.state_json = current.state_json;
      record.state_version = current.state_version;
    }
    await x.saveInstance(record, old?.config_version);
  }
  async activate(id: string) {
    await this.retire(id);
    await this.initialize(
      requireValue(await this.db.read((r) => r.instance(id))),
    );
  }
  async save(input: {
    id?: string;
    stage?: Stage;
    pluginId: string;
    version: string;
    name: string;
    config: Config;
    maxStorageBytes?: number | null;
    expectedVersion?: number;
    secretEdits?: Record<string, SecretEdit>;
    upgrade?: UpgradeIntent;
  }): Promise<Instance> {
    return this.mutex.run(async () => {
      const prepared = await this.prepare(input);
      await this.db.transaction((r) => this.persistPrepared(r, prepared));
      await this.activate(prepared.record.id);
      return requireValue(
        await this.db.read((r) => r.instance(prepared.record.id)),
      );
    });
  }
  cacheConfiguration(record: Instance): Config {
    return mergeConfig(
      record.config_json,
      this.secrets.decrypt(record.secrets_encrypted, record.id),
    );
  }
  acquire<K extends keyof Runtimes>(
    id: string,
    kind: K,
  ): {
    runtime: Runtimes[K];
    record: Instance;
    release: () => Promise<void>;
  } {
    const slot = this.slots.get(id);
    if (
      !slot ||
      (slot.record.kind === "processor"
        ? slot.record.stage !== kind
        : slot.record.kind !== kind)
    )
      throw new AppError(
        "INSTANCE_UNAVAILABLE",
        "Plugin instance is unavailable",
        503,
      );
    slot.refs++;
    let released = false;
    return {
      runtime: slot.runtime as Runtimes[K],
      record: structuredClone(slot.record),
      release: async () => {
        if (released) return;
        released = true;
        slot.refs--;
        await this.dispose(slot);
      },
    };
  }
  async close() {
    for (const id of [...this.slots.keys()]) await this.retire(id);
    if ([...this.retired].some((s) => s.refs))
      throw new Error("Plugin calls still active");
  }
  definitionsView(): import("../../shared/config").PluginView[] {
    const view = (d: Descriptor<Runtime> & { paramsSchema?: Config }) => ({
      configSchemaVersion: d.configSchemaVersion,
      configSchema: structuredClone(d.configSchema),
      uiHints: structuredClone(d.uiHints ?? {}),
      defaultLocale: d.defaultLocale,
      content: structuredClone(d.content),
      ...(d.paramsSchema
        ? { paramsSchema: structuredClone(d.paramsSchema) }
        : {}),
    });
    return [...this.definitions.values()].map((d) => ({
      id: d.id,

      version: d.version,
      ...(d.kind === "processor"
        ? {
            kind: d.kind,
            defaultLocale: d.defaultLocale,
            content: structuredClone(d.content),
            supportedStages: Object.keys(d.stages) as Stage[],
            stages: Object.fromEntries(
              Object.entries(d.stages).map(([key, desc]) => [key, view(desc)]),
            ),
          }
        : { ...view(d), kind: d.kind }),
    }));
  }
  isReady(id: string, kind?: Kind) {
    const slot = this.slots.get(id);
    return !!slot && (!kind || slot.record.kind === kind);
  }
  async revealSecret(id: string, path: string): Promise<Json | undefined> {
    const record = requireValue(await this.db.read((r) => r.instance(id)));
    if (!sensitivePaths(this.descriptor(record).configSchema).includes(path))
      throw new AppError("CONFIG_INVALID", "Unknown sensitive field");
    return readPointer(
      this.secrets.decrypt(record.secrets_encrypted, id),
      path,
    );
  }
  configurationView(record: Instance) {
    const id = record.id;
    const definition = this.definitions.get(
      record.plugin_id + "@" + record.plugin_version,
    );
    const secret = this.secrets.decrypt(record.secrets_encrypted, id);
    const presence: Record<string, boolean> = {};
    for (const path of definition
      ? sensitivePaths(this.descriptor(record).configSchema)
      : [])
      presence[path] = readPointer(secret, path) !== undefined;
    return {
      key: id,
      pluginId: record.plugin_id,
      version: record.plugin_version,
      config: structuredClone(record.config_json),
      secretPresence: presence,
      ready: this.isReady(id),
      error: record.last_init_error ? "插件初始化失败，请检查配置后重试" : null,
    };
  }
  async view(id: string): Promise<import("../../shared/config").InstanceView> {
    return this.db.read(
      async (r) =>
        (await this.instanceViews(r, [requireValue(await r.instance(id))]))[0]!,
    );
  }
  async storageViews(): Promise<import("../../shared/config").InstanceView[]> {
    return this.db.read(async (r) =>
      this.instanceViews(
        r,
        (await r.instances()).filter((i) => i.kind === "storage"),
      ),
    );
  }
  private async instanceViews(
    r: import("../persistence/port").Repositories,
    records: Instance[],
  ): Promise<import("../../shared/config").InstanceView[]> {
    const ids = records.map((i) => i.id);
    const references = await r.referencesForInstances(ids);
    const counts = await r.replicaCounts(ids);
    const usage = await r.storageUsage(ids);
    return records.map((record) => {
      const { key, ...configuration } = this.configurationView(record);
      return {
        ...configuration,
        id: key,
        kind: record.kind,
        name: record.name,
        maxStorageBytes: record.max_storage_bytes ?? null,
        usedStorageBytes: usage.get(record.id)?.used ?? 0,
        reservedStorageBytes: usage.get(record.id)?.reserved ?? 0,
        configVersion: record.config_version,
        canImport:
          record.kind === "storage" &&
          typeof (
            this.slots.get(record.id)?.runtime as
              | import("./api").StoragePlugin
              | undefined
          )?.listFiles === "function",
        references: references.get(record.id) ?? [],
        replicaCount: counts.get(record.id) ?? 0,
      };
    });
  }
  async reinitialize(id: string) {
    return this.mutex.run(async () => {
      const record = requireValue(await this.db.read((r) => r.instance(id)));
      await this.retire(id);
      await this.initialize(record);
      return this.view(id);
    });
  }
  async remove(id: string) {
    return this.mutex.run(async () => {
      requireValue(await this.db.read((r) => r.instance(id)));
      if (
        (this.slots.get(id)?.refs ?? 0) ||
        [...this.retired].some((s) => s.record.id === id && s.refs)
      )
        throw new Conflict("实例仍有在途调用");
      await this.db.transaction(async (r) => {
        await r.pruneTerminalReferences(id);
        const refs = await r.instanceReferences(id);
        const replicaCount = await r.instanceReplicaCount(id);
        if (refs.length || replicaCount)
          throw new Conflict(
            "实例仍被引用：" +
              refs
                .slice(0, 5)
                .map((x) => x.name)
                .join("、") +
              (replicaCount ? `；文件副本：${replicaCount}` : ""),
          );
        await r.deleteInstance(id);
      });
      await this.retire(id);
    });
  }
}
