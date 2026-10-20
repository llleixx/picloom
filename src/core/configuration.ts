import { pointer } from "../../shared/config";
import {
  entity,
  type Persistence,
  type Repositories,
} from "../persistence/port";
import type { PluginManager } from "../plugins/manager";
import type { Files } from "./files";
import { AppError, Conflict, requireValue } from "./errors";
import { prefix } from "../infra/files";
import type {
  AccessParameterGroup,
  Config,
  GroupView,
  ProfileView,
  PipelineStep,
  PipelineView,
  PipelineInput,
  GroupInput,
  ProfileInput,
} from "../../shared/config";

const name = (value: unknown) => {
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    throw new AppError("INVALID_INPUT", "名称须为 1–100 字符");
  return value.trim();
};
const version = (value: unknown, current: number) => {
  if (value !== current) throw new Conflict("配置已被修改，请重新读取");
};
export class Configuration {
  constructor(
    private db: Persistence,
    private plugins: PluginManager,
    private files: Files,
  ) {}
  async accessParameters(): Promise<AccessParameterGroup[]> {
    return this.db.read(async (r) => {
      const pipeline = await r.accessPipeline();
      if (!pipeline) return [];
      const result: AccessParameterGroup[] = [];
      for (const step of await r.steps(pipeline.id)) {
        const instance = requireValue(
          (await r.instances([step.plugin_instance_id]))[0],
        );
        const descriptor = this.plugins.descriptor(instance);
        const definition = this.plugins.definition(instance);
        const properties = (descriptor.paramsSchema?.properties ??
          {}) as Record<string, Config>;
        const exposed = Object.fromEntries(
          step.enabled_params
            .filter((key) => properties[key])
            .map((key) => [key, properties[key]!]),
        );
        if (!Object.keys(exposed).length) continue;
        result.push({
          id: instance.id,
          plugin: {
            id: definition.id,
            defaultLocale: definition.defaultLocale,
            content: definition.content,
          },
          defaultLocale: descriptor.defaultLocale,
          paramsSchema: { type: "object", properties: exposed },
          content: Object.fromEntries(
            Object.entries(descriptor.content).map(([locale, value]) => {
              return [
                locale,
                {
                  paramsSchema: Object.fromEntries(
                    Object.entries(value?.paramsSchema ?? {}).filter(([path]) =>
                      Object.keys(exposed).some(
                        (key) => path === "/properties/" + pointer(key),
                      ),
                    ),
                  ),
                },
              ];
            }),
          ),
        });
      }
      return result;
    });
  }
  async pluginUsages(
    pluginId: string,
  ): Promise<import("../../shared/config").PluginUsage[]> {
    return this.db.read(async (r) => {
      const instances = new Map(
        (await r.instances())
          .filter((i) => i.plugin_id === pluginId)
          .map((i) => [i.id, i]),
      );
      const result: import("../../shared/config").PluginUsage[] = [];
      for (const i of instances.values())
        if (i.kind === "storage")
          result.push({
            key: i.id,
            version: i.plugin_version,
            ownerType: "source",
            ownerId: i.id,
            name: i.name,
          });
      for (const p of await r.profiles()) {
        const i = instances.get(p.path_instance_id);
        if (i)
          result.push({
            key: i.id,
            version: i.plugin_version,
            ownerType: "profile",
            ownerId: p.id,
            name: p.name,
          });
      }
      const pipelines = await r.pipelines();
      const allSteps = await r.stepsForPipelines(pipelines.map((p) => p.id));
      for (const p of pipelines) {
        const steps = allSteps.get(p.id) ?? [];
        steps.forEach((step, index) => {
          const i = instances.get(step.plugin_instance_id);
          if (i)
            result.push({
              key: i.id,
              version: i.plugin_version,
              ownerType: "pipeline",
              ownerId: p.id,
              name: p.name,
              stage: p.kind,
              stepIndex: index,
            });
        });
      }
      return result;
    });
  }
  private async pluginConfiguration(
    id: string,
  ): Promise<import("../../shared/config").PluginConfiguration> {
    const record = requireValue(await this.db.read((r) => r.instance(id)));
    return this.plugins.configurationView(record);
  }

  async profileEditor(
    id: string,
  ): Promise<import("../../shared/config").ProfileEditor> {
    const p = await this.profile(id);
    const { pathInstanceId, ...fields } = p;
    return { ...fields, path: await this.pluginConfiguration(pathInstanceId) };
  }
  private async prepareOwned(
    value: import("../../shared/config").PluginConfiguration,
    kind: "path" | "processor",
    allowed: Set<string>,
    label: string,
    stage?: import("../plugins/api").Stage,
  ) {
    if (
      !value ||
      typeof value.pluginId !== "string" ||
      typeof value.version !== "string" ||
      !value.config ||
      typeof value.config !== "object" ||
      Array.isArray(value.config)
    )
      throw new AppError("INVALID_INPUT", "请选择插件并填写配置");
    if (value.key && !allowed.has(value.key))
      throw new AppError("INVALID_INPUT", "不能引用其他配置中的插件设置");
    const previous = value.key
      ? requireValue(await this.db.read((r) => r.instance(value.key!)))
      : null;
    const same =
      previous?.plugin_id === value.pluginId &&
      (previous?.plugin_version === value.version || !!value.upgrade);
    const prepared = await this.plugins.prepare({
      stage,
      id: same ? previous!.id : undefined,
      pluginId: value.pluginId,
      version: value.version,
      name: label.slice(0, 100),
      config: value.config,
      secretEdits: value.secretEdits,
      upgrade: value.upgrade,
      expectedVersion: same ? previous!.config_version : undefined,
    });
    if (prepared.record.kind !== kind)
      throw new AppError("INVALID_INPUT", "插件类型不匹配");
    return prepared;
  }
  private async prepareOwnedSteps(
    values: import("../../shared/config").ConfiguredStep[],
    old: PipelineStep[],
    stage: import("../plugins/api").Stage,
    label: string,
  ) {
    if (!Array.isArray(values) || values.length > 100)
      throw new AppError("INVALID_INPUT", "处理链最多 100 步");
    const allowed = new Set(old.map((s) => s.instanceId)),
      used = new Set<string>(),
      prepared = [];
    for (const [n, value] of values.entries()) {
      if (
        !value ||
        (stage === "post_save"
          ? value.onNotApplicable !== undefined
          : !["skip", "abort"].includes(value.onNotApplicable ?? "")) ||
        (value.key && used.has(value.key))
      )
        throw new AppError("INVALID_INPUT", "处理步骤无效或重复");
      if (value.key) used.add(value.key);
      try {
        prepared.push(
          await this.prepareOwned(
            value,
            "processor",
            allowed,
            `${label} ${n + 1}`,
            stage,
          ),
        );
      } catch (error) {
        if (error instanceof AppError && error.fields?.length)
          throw new AppError(
            error.code,
            error.message,
            error.status,
            error.fields.map((field) => ({
              ...field,
              path: `/steps/${n}/config${field.path}`,
            })),
          );
        throw error;
      }
    }
    return prepared;
  }
  async saveProfileEditor(
    input: import("../../shared/config").ProfileEditor & {
      expectedVersion?: number;
    },
    id?: string,
  ) {
    const result = await this.plugins.exclusive(async () => {
      const old = id ? await this.profile(id) : null;
      if (old) version(input.expectedVersion, old.configVersion);
      if (
        typeof input.enabled !== "boolean" ||
        (input.allowGuestUpload !== undefined &&
          typeof input.allowGuestUpload !== "boolean") ||
        (input.maxUploadBytes !== null &&
          (!Number.isSafeInteger(input.maxUploadBytes) ||
            input.maxUploadBytes <= 0)) ||
        !Array.isArray(input.allowedMimeTypes) ||
        !input.allowedMimeTypes.length ||
        input.allowedMimeTypes.some(
          (t) => typeof t !== "string" || !/^image\/[\w.+-]+$/.test(t),
        )
      )
        throw new AppError("INVALID_INPUT", "上传限制无效");
      if (this.files.profileClosing.has(id ?? ""))
        throw new Conflict("上传配置正在删除");
      const label = name(input.name),
        path = await this.prepareOwned(
          input.path,
          "path",
          new Set(old ? [old.pathInstanceId] : []),
          label + " · Path",
        );
      const removed =
        old && old.pathInstanceId !== path.record.id
          ? [old.pathInstanceId]
          : [];
      const result = await this.db.transaction(async (r) => {
        await this.plugins.persistPrepared(r, path);
        const saved = await this.writeProfile(
          r,
          {
            ...input,
            pathInstanceId: path.record.id,
          },
          id,
          true,
        );
        for (const key of removed) await r.deleteInstance(key);
        return saved;
      });
      for (const key of removed) await this.plugins.retire(key);
      await this.plugins.activate(path.record.id);
      return result;
    });
    return this.profileEditor(result);
  }
  async pipelines(): Promise<PipelineView[]> {
    return this.db.read(async (r) =>
      this.pipelineViews(r, await r.pipelines()),
    );
  }
  async pipeline(id: string): Promise<PipelineView> {
    return this.db.read(
      async (r) =>
        (await this.pipelineViews(r, [requireValue(await r.pipeline(id))]))[0]!,
    );
  }
  private async pipelineViews(
    r: Repositories,
    pipelines: import("../persistence/port").Pipeline[],
  ): Promise<PipelineView[]> {
    if (!pipelines.length) return [];
    const steps = await r.stepsForPipelines(pipelines.map((p) => p.id));
    const ids = [
      ...new Set([...steps.values()].flat().map((s) => s.plugin_instance_id)),
    ];
    const instances = new Map(
      (await r.instances(ids)).map((i) => [
        i.id,
        this.plugins.configurationView(i),
      ]),
    );
    const references = new Map<
      string,
      import("../../shared/config").Reference[]
    >();
    for (const p of await r.profiles()) {
      for (const id of new Set([
        p.upload_pipeline_id,
        p.post_save_pipeline_id,
      ])) {
        if (!id) continue;
        const refs = references.get(id) ?? [];
        refs.push({ type: "profile", id: p.id, name: p.name });
        references.set(id, refs);
      }
    }
    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      configVersion: p.config_version,
      references: references.get(p.id) ?? [],
      steps: (steps.get(p.id) ?? []).map((s) => ({
        ...requireValue(instances.get(s.plugin_instance_id)),
        ...(p.kind !== "post_save" ? { enabledParams: s.enabled_params } : {}),
        ...(s.on_not_applicable
          ? { onNotApplicable: s.on_not_applicable }
          : {}),
      })),
    }));
  }
  async savePipeline(input: PipelineInput, id?: string) {
    const result = await this.plugins.exclusive(async () => {
      const old = id ? await this.pipeline(id) : null;
      if (old) version(input.expectedVersion, old.configVersion);
      if (
        !["upload", "post_save", "access"].includes(input.kind) ||
        (old ? old.kind !== input.kind : input.kind === "access")
      )
        throw new AppError(
          "INVALID_INPUT",
          "Pipeline kind is fixed; access is global",
        );
      const label = name(input.name);
      const prepared = await this.prepareOwnedSteps(
        input.steps,
        old?.steps.map((s) => ({ instanceId: s.key! })) ?? [],
        input.kind,
        label,
      );
      for (const [n, p] of prepared.entries()) {
        const enabled = input.steps[n]!.enabledParams;
        const properties = this.plugins.descriptor(p.record).paramsSchema
          ?.properties as Record<string, unknown> | undefined;
        if (
          enabled !== undefined &&
          (!Array.isArray(enabled) ||
            (input.kind === "post_save" && enabled.length > 0) ||
            new Set(enabled).size !== enabled.length ||
            enabled.some(
              (k) =>
                typeof k !== "string" || !Object.hasOwn(properties ?? {}, k),
            ))
        )
          throw new AppError(
            "INVALID_INPUT",
            "Invalid enabled request parameters",
          );
      }
      const retained = new Set(prepared.map((p) => p.record.id));
      const removed = (old?.steps ?? [])
        .map((s) => s.key!)
        .filter((key) => !retained.has(key));
      const saved = await this.db.transaction(async (r) => {
        const current = id ? requireValue(await r.pipeline(id)) : null;
        if (current) version(input.expectedVersion, current.config_version);
        const record = {
          ...(current ?? entity()),
          name: label,
          kind: input.kind,
          config_version: (current?.config_version ?? 0) + 1,
          updated_at: Date.now(),
        };
        for (const p of prepared) await this.plugins.persistPrepared(r, p);
        if (current) await r.savePipeline(record, current.config_version);
        else await r.insertPipeline(record);
        const previousSteps = current ? await r.steps(record.id) : [];
        await r.replaceSteps(
          record.id,
          prepared.map((p, position) => ({
            ...(previousSteps.find(
              (s) => s.plugin_instance_id === p.record.id,
            ) ?? entity()),
            pipeline_id: record.id,
            position,
            plugin_instance_id: p.record.id,
            enabled_params:
              input.kind !== "post_save"
                ? (input.steps[position]!.enabledParams ?? [])
                : [],
            on_not_applicable:
              input.kind === "post_save"
                ? null
                : input.steps[position]!.onNotApplicable!,
          })),
        );
        for (const key of removed) await r.deleteInstance(key);
        return record.id;
      });
      for (const key of removed) await this.plugins.retire(key);
      for (const p of prepared) await this.plugins.activate(p.record.id);
      return saved;
    });
    return this.pipeline(result);
  }
  async duplicatePipeline(id: string) {
    const result = await this.plugins.exclusive(async () => {
      const old = await this.pipeline(id);
      if (old.kind === "access")
        throw new AppError("INVALID_INPUT", "Access pipeline is global");
      const prepared = await Promise.all(
        old.steps.map((s) => this.plugins.prepareCopy(s.key!)),
      );
      const pipeline = {
        ...entity(),
        name: (old.name + " copy").slice(0, 100),
        kind: old.kind,
        config_version: 1,
      };
      await this.db.transaction(async (r) => {
        await r.insertPipeline(pipeline);
        for (const [position, p] of prepared.entries()) {
          await this.plugins.persistPrepared(r, p);
          await r.insertStep({
            ...entity(),
            pipeline_id: pipeline.id,
            position,
            plugin_instance_id: p.record.id,
            enabled_params: old.steps[position]!.enabledParams ?? [],
            on_not_applicable: old.steps[position]!.onNotApplicable ?? null,
          });
        }
      });
      for (const p of prepared) await this.plugins.activate(p.record.id);
      return pipeline.id;
    });
    return this.pipeline(result);
  }
  async deletePipeline(id: string) {
    await this.plugins.exclusive(async () => {
      const removed = await this.db.transaction(async (r) => {
        const p = requireValue(await r.pipeline(id));
        if (p.kind === "access")
          throw new Conflict("Global access pipeline cannot be deleted");
        const refs = (await r.profiles()).filter(
          (p) => p.upload_pipeline_id === id || p.post_save_pipeline_id === id,
        );
        if (refs.length)
          throw new Conflict("Pipeline is referenced by upload profiles");
        const keys = (await r.steps(id)).map((s) => s.plugin_instance_id);
        await r.deletePipeline(id);
        for (const key of keys) await r.deleteInstance(key);
        return keys;
      });
      for (const key of removed) await this.plugins.retire(key);
    });
  }
  private async reference(
    r: Repositories,
    id: string,
    kind: "path" | "storage" | "processor",
    existed = false,
  ) {
    const record = requireValue(await r.instance(id));
    if (record.kind !== kind)
      throw new AppError("INVALID_INPUT", "插件类型不匹配");
    if (!existed && !this.plugins.isReady(id, kind))
      throw new AppError("INSTANCE_UNAVAILABLE", "不能引用尚未就绪的实例", 409);
  }
  async groups(): Promise<GroupView[]> {
    return this.db.read(async (r) => this.groupViews(r, await r.groups()));
  }
  async group(id: string): Promise<GroupView> {
    return this.db.read(
      async (r) =>
        (await this.groupViews(r, [requireValue(await r.group(id))]))[0]!,
    );
  }
  private async groupViews(
    r: Repositories,
    groups: import("../persistence/port").Group[],
  ): Promise<GroupView[]> {
    const members = await r.membersForGroups(groups.map((g) => g.id));
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      selectionStrategy: g.selection_strategy,
      redundancyCount: g.redundancy_count,
      configVersion: g.config_version,
      members: (members.get(g.id) ?? []).map((m) => ({
        instanceId: m.storage_instance_id,
        weight: m.weight,
      })),
    }));
  }
  async saveGroup(input: GroupInput, id?: string) {
    if (
      !Array.isArray(input.members) ||
      !input.members.length ||
      new Set(input.members.map((m) => m?.instanceId)).size !==
        input.members.length ||
      input.members.some(
        (x) =>
          !x ||
          typeof x.instanceId !== "string" ||
          !Number.isFinite(x.weight) ||
          x.weight <= 0,
      )
    )
      throw new AppError(
        "INVALID_INPUT",
        "成员不能为空或重复，权重须为有限正数",
      );
    if (
      !["priority", "weighted_random"].includes(input.selectionStrategy) ||
      !Number.isInteger(input.redundancyCount) ||
      input.redundancyCount < 0 ||
      input.redundancyCount >= input.members.length
    )
      throw new AppError("INVALID_INPUT", "存储选择策略或冗余数无效");
    const result = await this.db.transaction(async (r) => {
      const old = id ? requireValue(await r.group(id)) : null,
        existing = old
          ? (await r.members(old.id)).map((m) => m.storage_instance_id)
          : [];
      if (old) version(input.expectedVersion, old.config_version);
      for (const member of input.members)
        await this.reference(
          r,
          member.instanceId,
          "storage",
          existing.includes(member.instanceId),
        );
      const g = {
        ...(old ?? entity()),
        name: name(input.name),
        selection_strategy: input.selectionStrategy,
        redundancy_count: input.redundancyCount,
        config_version: (old?.config_version ?? 0) + 1,
        updated_at: Date.now(),
      };
      if (old) await r.saveGroup(g, old.config_version);
      else await r.insertGroup(g);
      await r.replaceMembers(g.id, input.members);
      return g.id;
    });
    return this.group(result);
  }
  async deleteGroup(id: string) {
    await this.db.transaction(async (r) => {
      requireValue(await r.group(id));
      if ((await r.profiles()).some((p) => p.storage_group_id === id))
        throw new Conflict("存储组仍被上传配置引用");
      await r.deleteGroup(id);
    });
  }
  async profile(id: string): Promise<ProfileView> {
    return this.db.read(async (r) => {
      const p = requireValue(await r.profile(id));
      return {
        id: p.id,
        name: p.name,
        publicPrefix: p.public_prefix,
        pathInstanceId: p.path_instance_id,
        storageGroupId: p.storage_group_id,
        enabled: p.enabled,
        allowGuestUpload: p.allow_guest_upload ?? false,
        configVersion: p.config_version,
        maxUploadBytes: p.max_upload_bytes,
        allowedMimeTypes: p.allowed_mime_types,
        uploadPipelineId: p.upload_pipeline_id,
        postSavePipelineId: p.post_save_pipeline_id,
      };
    });
  }
  async saveProfile(input: ProfileInput, id?: string) {
    if (
      typeof input.enabled !== "boolean" ||
      (input.allowGuestUpload !== undefined &&
        typeof input.allowGuestUpload !== "boolean") ||
      (input.maxUploadBytes !== null &&
        (!Number.isSafeInteger(input.maxUploadBytes) ||
          input.maxUploadBytes <= 0)) ||
      !Array.isArray(input.allowedMimeTypes) ||
      !input.allowedMimeTypes.length ||
      input.allowedMimeTypes.some(
        (t) => typeof t !== "string" || !/^image\/[\w.+-]+$/.test(t),
      )
    )
      throw new AppError("INVALID_INPUT", "上传限制无效");
    if (this.files.profileClosing.has(id ?? ""))
      throw new Conflict("上传配置正在删除");
    const result = await this.db.transaction((r) =>
      this.writeProfile(r, input, id),
    );
    return this.profile(result);
  }
  private async writeProfile(
    r: Repositories,
    input: ProfileInput,
    id?: string,
    allowUnready = false,
  ) {
    const old = id ? requireValue(await r.profile(id)) : null;
    if (old) version(input.expectedVersion, old.config_version);
    await this.reference(
      r,
      input.pathInstanceId,
      "path",
      allowUnready || old?.path_instance_id === input.pathInstanceId,
    );
    requireValue(await r.group(input.storageGroupId));
    for (const [key, kind, previous] of [
      [input.uploadPipelineId, "upload", old?.upload_pipeline_id],
      [input.postSavePipelineId, "post_save", old?.post_save_pipeline_id],
    ] as const) {
      if (key === null) continue;
      if (typeof key !== "string")
        throw new AppError("INVALID_INPUT", "Invalid pipeline reference");
      const pipeline = requireValue(await r.pipeline(key));
      if (pipeline.kind !== kind)
        throw new AppError("INVALID_INPUT", "Pipeline type mismatch");
      if (key !== previous)
        for (const step of await r.steps(key))
          await this.reference(r, step.plugin_instance_id, "processor");
    }
    prefix(input.publicPrefix);
    const p = {
      ...(old ?? entity()),
      name: name(input.name),
      is_default: old?.is_default ?? false,
      public_prefix: input.publicPrefix,
      path_instance_id: input.pathInstanceId,
      storage_group_id: input.storageGroupId,
      upload_pipeline_id: input.uploadPipelineId,
      post_save_pipeline_id: input.postSavePipelineId,
      enabled: input.enabled,
      allow_guest_upload: input.allowGuestUpload ?? false,
      max_upload_bytes: input.maxUploadBytes,
      allowed_mime_types: [...new Set(input.allowedMimeTypes)],
      config_version: (old?.config_version ?? 0) + 1,
      updated_at: Date.now(),
    };
    if (old) await r.saveProfile(p, old.config_version);
    else await r.insertProfile(p);
    return p.id;
  }
  async deleteProfile(id: string) {
    if (this.files.profileClosing.has(id))
      throw new Conflict("上传配置正在删除");
    this.files.profileClosing.add(id);
    try {
      await this.files.profileInFlight.wait(id);
      await this.plugins.exclusive(async () => {
        const removed = await this.db.transaction(async (r) => {
          const profile = requireValue(await r.profile(id));
          const keys = [profile.path_instance_id];
          await r.deleteProfile(id);
          for (const key of keys) await r.deleteInstance(key);
          return keys;
        });
        for (const key of removed) await this.plugins.retire(key);
      });
    } finally {
      this.files.profileClosing.delete(id);
    }
  }
}
