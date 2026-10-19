import { TemporarySpace } from "../infra/temporary-space";
import { isPluginError } from "../../plugin-sdk/api";
import { isSiteAdmin } from "../../shared/roles";
import { DerivedImages } from "./derived-images";
import { imageMimeFromKey } from "../../shared/import";
import {
  imageHeaders,
  publicCacheControl,
  emptyImageResponse,
  derivedImageResponse,
  type ImageRequest,
} from "./image-response";
import { pipelineData } from "./pipeline-data";
import type { AccessPlugin, Parameters } from "../plugins/api";
import { requestParameters } from "./request-params";
import { TaskExecutor } from "./tasks";
import { selectStorage } from "./storage-selection";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Settings } from "../config";
import {
  entity,
  type Persistence,
  type FileRecord,
  type Replica,
  type Step,
  type Task,
} from "../persistence/port";
import type { PluginManager } from "../plugins/manager";
import {
  type Context,
  type Metadata,
  type Query,
  type ProcessorPlugin,
  type Output,
  type FileInput,
} from "../plugins/api";
import { AppError, Conflict, requireValue } from "./errors";
import { InFlight, Limiter } from "./concurrency";
import {
  prefix,
  publicPathKey,
  fileInput,
  logicalKey,
  output,
  publicPath,
  retainStream,
  prefetchStream,
  scopedInput,
} from "../infra/files";
import { identify } from "../infra/images";
import { cacheKey, ImageCache } from "./cache";
import type { UploadProfileView } from "../../shared/api";
import type { Auth, Identity, UploadIdentity } from "./auth";
export interface Faults {
  beforeWrite?(): Promise<void>;
  afterWrite?(): Promise<void>;
  beforePublish?(): Promise<void>;
  beforeDelete?(): Promise<void>;
}
export class Files {
  private inFlight = new InFlight();
  readonly profileInFlight = new InFlight();
  readonly profileClosing = new Set<string>();
  readonly tasks: TaskExecutor;
  random: () => number = Math.random;
  private limit: Limiter;
  private derived: DerivedImages;
  readonly cache: ImageCache;
  readonly temporary: TemporarySpace;
  constructor(
    private db: Persistence,
    private plugins: PluginManager,
    private auth: Auth,
    private config: Settings,
    private faults: Faults = {},
  ) {
    this.temporary = new TemporarySpace(config);
    this.limit = new Limiter(
      config.processingConcurrency,
      config.processingQueue,
    );
    this.cache = new ImageCache(
      join(config.root, "cache"),
      config.cacheBytes,
      config.cacheTtlMs,
    );
    this.derived = new DerivedImages(
      db,
      config,
      this.cache,
      this.limit,
      this.temporary,
      {
        ready: (id) => this.ready(id),
        read: async (file, signal) => {
          const result = await this.read(file, "stream", this.context(signal));
          if (result.type !== "stream") throw new Error("Expected stream");
          return result.stream;
        },
      },
    );
    this.tasks = new TaskExecutor(
      db,
      plugins,
      config,
      this.inFlight,
      this.cache,
      this.temporary,
      faults.beforeDelete,
    );
  }
  private context(
    signal: AbortSignal,
    requestId = crypto.randomUUID(),
  ): Context {
    return {
      signal,
      requestId,
      log(event) {
        console.info(JSON.stringify({ event: event.slice(0, 120), requestId }));
      },
    };
  }
  private temp() {
    return this.temporary.create();
  }
  private async discard(path: string) {
    await this.temporary.remove(path);
  }
  private acquireSteps(steps: Step[], stage: "upload" | "access") {
    const result: Array<{ step: Step } & ReturnType<PluginManager["acquire"]>> =
      [];
    try {
      for (const step of steps)
        result.push({
          step,
          ...this.plugins.acquire(step.plugin_instance_id, stage),
        });
      return result as Array<{
        step: Step;
        runtime: ProcessorPlugin | AccessPlugin;
        record: ReturnType<PluginManager["acquire"]>["record"];
        release: () => Promise<void>;
      }>;
    } catch (e) {
      for (const item of result) void item.release();
      throw e;
    }
  }
  private async pipeline(
    path: string,
    metadata: Metadata,
    params: Parameters[],
    steps: ReturnType<Files["acquireSteps"]>,
    ctx: Context,
    owned: Set<string>,
    load?: () => Promise<{ path: string; metadata: Metadata }>,
  ) {
    let loaded = !load;
    const data = pipelineData();
    const execution = { ...ctx, data };
    const checking = { ...ctx, data: { get: data.get } };
    for (const [index, item] of steps.entries()) {
      ctx.signal.throwIfAborted();
      const created = new Map<string, { output: Output; path: string }>();
      const writes: Promise<void>[] = [];
      let scope = loaded
        ? scopedInput(fileInput(path, metadata), ctx.signal)
        : undefined;
      let pending: Promise<FileInput> | undefined;
      let active = true;
      const getFile = () => {
        ctx.signal.throwIfAborted();
        if (!active) throw new Error("Processor step has ended");
        return (pending ??= (async () => {
          if (!loaded) {
            ({ path, metadata } = await load!());
            loaded = true;
          }
          scope ??= scopedInput(fileInput(path, metadata), ctx.signal);
          return scope.file;
        })());
      };
      const input = {
        file: scope?.file as FileInput,
        metadata: Object.freeze({ ...metadata }),
        getFile,
        params: params[index]!,
        limits: {
          maxDimension: this.config.maxDimension,
          maxPixels: this.config.maxPixels,
        },
        createOutput: async () => {
          const p = this.temp();
          owned.add(p);
          let written = false;
          const value = output(p, (stream) => {
            if (!active || written)
              throw new AppError("PLUGIN_OUTPUT", "Output is closed", 500);
            written = true;
            const pending = this.temporary
              .write(
                p,
                stream,
                load ? this.config.uploadTempBytes : this.config.maxUploadBytes,
                ctx.signal,
              )
              .then(() => {});
            writes.push(pending);
            void pending.catch(() => {});
            return pending;
          });
          created.set(value.handle, { output: value, path: p });
          return value;
        },
      };
      try {
        const { createOutput, ...checkInput } = input;
        const { file: _file, ...accessCheckInput } = checkInput;
        const check = load
          ? await (item.runtime as AccessPlugin).check(
              accessCheckInput,
              checking,
            )
          : await (item.runtime as ProcessorPlugin).check(checkInput, checking);
        if (
          !check ||
          typeof check !== "object" ||
          Array.isArray(check) ||
          !["applicable", "noop", "unsupported"].includes(check.status) ||
          (check.reason !== undefined && typeof check.reason !== "string")
        )
          throw new AppError(
            "PROCESSING_RESULT_INVALID",
            "Processor check returned an invalid result",
            500,
          );
        if (check.status === "noop") continue;
        if (check.status === "unsupported") {
          if (item.step.on_not_applicable === "skip") continue;
          throw new AppError(
            "UNSUPPORTED",
            check.reason ?? "Processor does not support this file",
            422,
          );
        }
        const result = load
          ? await (item.runtime as AccessPlugin).process(
              { ...accessCheckInput, createOutput },
              execution,
            )
          : await (item.runtime as ProcessorPlugin).process(input, execution);
        if (
          !result ||
          typeof result !== "object" ||
          Array.isArray(result) ||
          !["pass", "replace", "reject"].includes(result.status) ||
          (result.status === "reject" && typeof result.reason !== "string") ||
          (result.status === "replace" &&
            (!result.output ||
              typeof result.output !== "object" ||
              Array.isArray(result.output) ||
              typeof result.output.handle !== "string"))
        )
          throw new AppError(
            "PROCESSING_RESULT_INVALID",
            "Processor process returned an invalid result",
            500,
          );
        if (result.status === "reject")
          throw new AppError("REJECTED", result.reason, 422);
        if (result.status === "replace") {
          if (created.get(result.output.handle)?.output !== result.output)
            throw new AppError(
              "PLUGIN_OUTPUT",
              "Plugin returned an unowned output",
              500,
            );
          loaded = true;
          await Promise.all(writes);
          path = created.get(result.output.handle)!.path;
          metadata = await identify(path, this.config.maxPixels, ctx.signal);
          if (
            metadata.width! > this.config.maxDimension ||
            metadata.height! > this.config.maxDimension
          )
            throw new AppError(
              "INVALID_PARAMS",
              "Output exceeds dimension limit",
            );
        }
      } catch (error) {
        if (isPluginError(error) && error.code === "INVALID_INPUT")
          throw new AppError("INVALID_PARAMS", "Invalid processor parameters");
        throw error;
      } finally {
        active = false;
        await Promise.allSettled(writes);
        if (pending) await pending.catch(() => {});
        await scope?.close();
      }
    }
    return { path, metadata, loaded };
  }
  private async uploadPlan(profileId: string) {
    if (this.profileClosing.has(profileId))
      throw new AppError("PROFILE_CLOSING", "上传配置正在删除", 409);
    const plan = await this.db.read(async (r) => {
      const p = requireValue(
        await r.profile(profileId),
        "Upload profile not found",
      );
      if (!p.enabled)
        throw new AppError("DISABLED", "Upload profile is disabled", 403);
      const g = requireValue(await r.group(p.storage_group_id));
      const members = await r.members(g.id);
      const eligible = [];
      for (const m of members) {
        const instance = requireValue(await r.instance(m.storage_instance_id));
        if (this.plugins.isReady(instance.id, "storage"))
          eligible.push({
            id: instance.id,
            priority: m.priority,
            weight: m.weight,
          });
      }
      if (eligible.length < g.redundancy_count + 1)
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "可用存储实例不足，无法满足冗余数",
          503,
        );
      const first = selectStorage(eligible, g.primary_strategy, this.random);
      const remaining = eligible.filter((m) => m.id !== first.id),
        targets: string[] = [];
      for (let n = 0; n < g.redundancy_count; n++) {
        const selected = selectStorage(
          remaining,
          g.redundancy_strategy,
          this.random,
        );
        targets.push(selected.id);
        remaining.splice(remaining.indexOf(selected), 1);
      }
      return {
        profile: p,
        storage: first.id,
        targets,
        steps: p.upload_pipeline_id ? await r.steps(p.upload_pipeline_id) : [],
        actions: p.post_save_pipeline_id
          ? await r.steps(p.post_save_pipeline_id)
          : [],
        pipelines: await Promise.all(
          [p.upload_pipeline_id, p.post_save_pipeline_id]
            .filter((id): id is string => !!id)
            .map(async (id) => requireValue(await r.pipeline(id))),
        ),
      };
    });
    const leases: Array<{ release(): Promise<void> }> = [];
    try {
      leases.push(this.plugins.acquire(plan.profile.path_instance_id, "path"));
      leases.push(this.plugins.acquire(plan.storage, "storage"));
      for (const action of plan.actions)
        leases.push(
          this.plugins.acquire(action.plugin_instance_id, "post_save"),
        );
      for (const step of plan.steps)
        leases.push(this.plugins.acquire(step.plugin_instance_id, "upload"));
    } finally {
      await Promise.all(leases.map((lease) => lease.release()));
    }
    return plan;
  }
  async uploadProfiles(
    identity: Identity | null,
  ): Promise<UploadProfileView[]> {
    const admin = identity?.kind === "session" && isSiteAdmin(identity.user.role);
    const profiles = await this.auth.allowedProfiles(identity);
    const limits = await this.auth.uploadLimits(identity);
    return Promise.all(
      profiles.map(async (p) => {
        let reason: string | null = null;
        let reasonCode: string | null = null;
        try {
          await this.uploadPlan(p.id);
        } catch (e) {
          reasonCode = e instanceof AppError ? e.code : "INSTANCE_UNAVAILABLE";
          reason =
            e instanceof AppError && e.code === "DISABLED"
              ? "上传配置已禁用"
              : e instanceof AppError && e.code === "STORAGE_UNAVAILABLE"
                ? "可用存储源不足，无法满足冗余数"
                : "配置关联的资源或插件实例不可用";
        }
        return {
          id: p.id,
          name: p.name,
          publicPrefix: p.public_prefix,
          maxUploadBytes: Math.min(p.max_upload_bytes, limits.maxBytes),
          allowedMimeTypes: p.allowed_mime_types,
          available: reason === null,
          reason: admin
            ? reason
            : reason === null
              ? null
              : "Upload profile unavailable",
          reasonCode: admin
            ? reasonCode
            : reason === null
              ? null
              : "UNAVAILABLE",
        };
      }),
    );
  }
  configureProcessing(concurrency: number, queue: number) {
    this.limit.configure(concurrency, queue);
  }
  async validateUpload(
    profileId: string,
    size: number,
    identity: UploadIdentity,
    guestIp: string | null = null,
  ) {
    await this.auth.checkUploadQuota(identity, size, guestIp);
    await this.auth.authorizeUpload(identity, profileId);
    const { profile } = await this.uploadPlan(profileId);
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > Math.min(profile.max_upload_bytes, this.config.maxUploadBytes)
    )
      throw new AppError("TOO_LARGE", "Invalid upload size", 413);
  }
  async upload(
    blob: Pick<File, "size" | "stream" | "name">,
    profileId: string,
    identity: UploadIdentity,
    signal: AbortSignal,
    params: Record<string, unknown> = {},
    fileId?: string,
    guestIp: string | null = null,
    inputPath?: string,
  ) {
    const prepared = inputPath
      ? { path: inputPath, adopted: false }
      : undefined;
    try {
      if (this.profileClosing.has(profileId))
        throw new AppError("PROFILE_CLOSING", "上传配置正在删除", 409);
      const end = this.profileInFlight.enter(profileId);
      try {
        return await this.performUpload(
          blob,
          profileId,
          identity,
          signal,
          params,
          fileId,
          guestIp,
          prepared,
        );
      } finally {
        end();
      }
    } finally {
      if (prepared && !prepared.adopted)
        await this.temporary.remove(prepared.path);
    }
  }
  private async performUpload(
    blob: Pick<File, "size" | "stream" | "name">,
    profileId: string,
    identity: UploadIdentity,
    signal: AbortSignal,
    params: Record<string, unknown>,
    fileId?: string,
    guestIp: string | null = null,
    prepared?: { path: string; adopted: boolean },
  ) {
    await this.auth.authorizeUpload(identity, profileId);
    await this.auth.checkUploadQuota(identity, blob.size, guestIp);
    const plan = await this.uploadPlan(profileId);
    if (
      blob.size === 0 ||
      blob.size >
        Math.min(plan.profile.max_upload_bytes, this.config.maxUploadBytes)
    )
      throw new AppError("TOO_LARGE", "Invalid upload size", 413);
    const base = { ...entity(), ...(fileId ? { id: fileId } : {}) };
    const end = this.inFlight.enter(base.id);
    const owned = new Set<string>();
    if (prepared) {
      owned.add(prepared.path);
      prepared.adopted = true;
    }
    let record: FileRecord | undefined;
    let replica: Replica | undefined;
    let written = false;
    let published = false;
    const redundant = plan.targets.map((id) => ({
      ...entity(),
      file_id: base.id,
      storage_instance_id: id,
      role: "redundant" as const,
      status: "pending" as const,
      locator_json: null,
    }));
    let pathLease:
      | {
          runtime: import("../plugins/api").PathPlugin;
          release: () => Promise<void>;
        }
      | undefined;
    let storageLease: ReturnType<PluginManager["acquire"]> | undefined;
    let chain: ReturnType<Files["acquireSteps"]> = [];
    const ctx = this.context(signal);
    try {
      pathLease = this.plugins.acquire(plan.profile.path_instance_id, "path");
      chain = this.acquireSteps(plan.steps, "upload");
      const effective = chain.map((item) =>
        requestParameters(
          this.plugins.descriptor(item.record).paramsSchema,
          item.step.enabled_params,
          params,
          "body",
        ),
      );
      storageLease = this.plugins.acquire(plan.storage, "storage");
      const storage =
        storageLease.runtime as import("../plugins/api").StoragePlugin;
      const temp = prepared?.path ?? this.temp();
      owned.add(temp);
      if (!prepared) {
        this.temporary.reserve(temp, blob.size);
        await this.temporary.write(
          temp,
          blob.stream(),
          plan.profile.max_upload_bytes,
          signal,
        );
      }
      const current = await this.limit.run(async () => {
        signal.throwIfAborted();
        const metadata = await identify(temp, this.config.maxPixels, signal);
        if (!plan.profile.allowed_mime_types.includes(metadata.mimeType!))
          throw new AppError("UNSUPPORTED", "Upload type not allowed", 415);
        return this.pipeline(temp, metadata, effective, chain, ctx, owned);
      }, signal);
      if (current.metadata.byteSize! > this.config.maxUploadBytes)
        throw new AppError("TOO_LARGE", "Processed upload exceeds limit", 413);
      if (
        !plan.profile.allowed_mime_types.includes(current.metadata.mimeType!) ||
        current.metadata.byteSize! > plan.profile.max_upload_bytes
      )
        throw new AppError(
          "UNSUPPORTED",
          "Final image exceeds upload policy",
          415,
        );
      const generated = await pathLease.runtime.generate(
        {
          fileId: base.id,
          uploadedAt: base.created_at,
          metadata: current.metadata,
          originalName: blob.name.split(/[\\/]/).pop(),
        },
        ctx,
      );
      const key = logicalKey(generated.logicalKey);
      const storageKey = logicalKey(generated.storageKey ?? key);
      record = {
        ...base,
        guest_ip: this.auth.uploadOwner(identity).ownerId ? null : guestIp,
        owner_id: this.auth.uploadOwner(identity).ownerId,
        upload_profile_id: plan.profile.id,
        storage_group_id: plan.profile.storage_group_id,
        public_prefix: plan.profile.public_prefix,
        logical_key: key,
        storage_key: storageKey,
        mime_type: current.metadata.mimeType,
        byte_size: current.metadata.byteSize,
        width: current.metadata.width,
        height: current.metadata.height,
        status: "preparing",
        temp_path: current.path.split(/[\\/]/).pop()!,
        temp_status: "available",
        last_error: null,
        deleted_at: null,
        processing_results_json: null,
      };
      replica = {
        ...entity(),
        file_id: base.id,
        storage_instance_id: plan.storage,
        role: "primary",
        status: "writing",
        locator_json: null,
      };
      await this.db.transaction(async (r) => {
        await this.auth.authorizeUpload(identity, profileId, r);
        prefix(record!.public_prefix);
        await r.insertFile(record!);
        await r.insertReplica(replica!);
        for (const item of redundant) await r.insertReplica(item);
      });
      owned.delete(current.path);
      await this.faults.beforeWrite?.();
      const inputScope = scopedInput(
        fileInput(current.path, current.metadata),
        signal,
      );
      try {
        const result = await storage.write(
          {
            operationId: `initial:${replica.id}`,
            fileId: base.id,
            storageKey,
            file: inputScope.file,
          },
          ctx,
        );
        written = true;
        replica.locator_json = result.locator ?? null;
        replica.status = "ready";
      } finally {
        await inputScope.close();
      }
      await this.faults.afterWrite?.();
      await this.faults.beforePublish?.();
      signal.throwIfAborted();
      await this.db.transaction(async (r) => {
        await this.auth.authorizeUpload(identity, profileId, r);
        const p = requireValue(await r.profile(plan.profile.id));
        if (!p.enabled || p.config_version !== plan.profile.config_version)
          throw new AppError(
            "PROFILE_CHANGED",
            "Upload configuration changed",
            409,
          );
        for (const pipeline of plan.pipelines) {
          const current = await r.pipeline(pipeline.id);
          if (!current || current.config_version !== pipeline.config_version)
            throw new AppError(
              "PROFILE_CHANGED",
              "Pipeline changed during upload",
              409,
            );
        }
        await this.auth.checkUploadQuota(identity, blob.size, guestIp, r, true);
        await r.saveReplica(replica!);
        record!.status = "ready";
        await r.saveFile(record!, "preparing");
        for (const item of redundant)
          await r.insertTask({
            ...entity(),
            kind: "write",
            file_id: base.id,
            replica_id: item.id,
            pipeline_id: null,
            status: "pending",
            attempts: 0,
            next_run_at: Date.now(),
            last_error: null,
          });
        if (plan.actions.length)
          await r.insertTask({
            ...entity(),
            kind: "action",
            file_id: base.id,
            replica_id: null,
            pipeline_id: plan.profile.post_save_pipeline_id,
            status: "pending",
            attempts: 0,
            next_run_at: Date.now(),
            last_error: null,
          });
      });
      published = true;
      if (!redundant.length && !plan.actions.length) {
        await this.temporary.remove(current.path);
        await this.db.transaction(async (r) => {
          const f = requireValue(await r.file(base.id));
          f.temp_path = null;
          f.temp_status = "cleaned";
          await r.saveFile(f, "ready");
        });
      }
      return {
        id: base.id,
        url: this.config.imageOrigin + publicPath(record.public_prefix, key),
      };
    } catch (e) {
      if (record && !published) {
        await this.db.transaction(async (r) => {
          const f = await r.file(base.id);
          if (!f) return;
          const previous = f.status;
          if (f.status !== "deleting") f.status = "failed";
          f.last_error = e instanceof AppError ? e.code : "UPLOAD_FAILED";
          await r.saveFile(f, previous);
          if (replica) {
            replica.status = written
              ? "ready"
              : isPluginError(e) && e.outcome === "notApplied"
                ? "write_failed"
                : "write_unknown";
            await r.saveReplica(replica);
          }
        });
      }
      if (published)
        return {
          id: base.id,
          url:
            this.config.imageOrigin +
            publicPath(record!.public_prefix, record!.logical_key),
        };
      throw e;
    } finally {
      try {
        const cleanup = await Promise.allSettled(
          [...owned].map((path) => this.discard(path)),
        );
        if (cleanup.some((result) => result.status === "rejected"))
          console.error(
            JSON.stringify({ event: "temp_cleanup_failed", fileId: base.id }),
          );
        await Promise.all([
          pathLease?.release(),
          storageLease?.release(),
          ...chain.map((step) => step.release()),
        ]);
      } finally {
        end();
      }
    }
  }
  async find(pathname: string) {
    const path = publicPathKey(pathname);
    return this.db.read(async (r) =>
      requireValue(await r.fileByPath(path), "Image not found"),
    );
  }

  private async ready(id: string) {
    const f = requireValue(await this.db.read((r) => r.file(id)));
    if (f.status !== "ready")
      throw new AppError("NOT_FOUND", "Image not available", 404);
    return f;
  }
  private async read(file: FileRecord, mode: "auto" | "stream", ctx: Context) {
    const weights = await this.db.read(async (r) => {
      const replicas = await r.replicas(file.id);
      const ready = replicas.filter((r) => r.status === "ready");
      if (!ready.length)
        throw new AppError("UNAVAILABLE", "No ready replica", 503);
      const members = file.storage_group_id
        ? await r.members(file.storage_group_id)
        : [];
      const byInstance = new Map(
        members.map((m) => [m.storage_instance_id, m.weight]),
      );
      return ready.map((replica) => ({
        replica,
        weight: byInstance.get(replica.storage_instance_id) ?? 1,
      }));
    });
    const remaining = weights.map((x) => ({ ...x, priority: 0 }));
    while (remaining.length) {
      ctx.signal.throwIfAborted();
      const selected = selectStorage(remaining, "weighted_random", this.random);
      remaining.splice(remaining.indexOf(selected), 1);
      let lease: ReturnType<PluginManager["acquire"]> | undefined;
      try {
        const storage = this.plugins.acquire(
          selected.replica.storage_instance_id,
          "storage",
        );
        lease = storage;
        const result = await storage.runtime.read(
          {
            storageKey: file.storage_key,
            locator: selected.replica.locator_json,
            mode,
          },
          ctx,
        );
        if (result.type === "stream") {
          const stream = await prefetchStream(result.stream, ctx.signal);
          return {
            ...result,
            stream: retainStream(stream, storage.release, ctx.signal),
          };
        }
        ctx.signal.throwIfAborted();
        if (mode === "stream")
          throw new AppError(
            "PLUGIN_RESULT",
            "Storage must return stream",
            502,
          );
        await storage.release();
        return result;
      } catch (error) {
        await lease?.release();
        ctx.signal.throwIfAborted();
        // Do not expose plugin error messages, which can contain URLs or credentials.
        console.warn(
          JSON.stringify({
            event: "replica_read_failed",
            fileId: file.id,
            replicaId: selected.replica.id,
            storageInstanceId: selected.replica.storage_instance_id,
            code: "READ_FAILED",
          }),
        );
      }
    }
    throw new AppError("UNAVAILABLE", "No readable replica", 503);
  }

  async preview(id: string, signal: AbortSignal, request: ImageRequest = {}) {
    const release = this.inFlight.enter(id);
    let transferred = false;
    try {
      const file = requireValue(await this.db.read((r) => r.file(id)));
      if (!["ready", "blocked"].includes(file.status))
        throw new AppError("NOT_FOUND", "Image not available", 404);
      const result = await this.read(file, "stream", this.context(signal));
      if (result.type !== "stream") throw new Error("Expected stream");
      try {
        const current = await this.db.read((r) => r.file(id));
        if (!current || !["ready", "blocked"].includes(current.status))
          throw new AppError("NOT_FOUND", "Image not available", 404);
      } catch (error) {
        await result.stream.cancel();
        throw error;
      }
      const headers = imageHeaders(
        this.config,
        file.mime_type ??
          imageMimeFromKey(file.logical_key) ??
          "application/octet-stream",
        undefined,
        file.byte_size,
      );
      headers.set("cache-control", "private, no-store");
      const empty = emptyImageResponse(request, headers);
      if (empty) {
        await result.stream.cancel();
        return empty;
      }
      transferred = true;
      return new Response(retainStream(result.stream, release, signal), {
        headers,
      });
    } finally {
      if (!transferred) release();
    }
  }
  async unblock(id: string) {
    await this.db.transaction(async (r) => {
      const file = requireValue(await r.file(id));
      if (file.status !== "blocked")
        throw new AppError("CONFLICT", "File is not blocked", 409);
      file.status = "ready";
      await r.saveFile(file, "blocked");
    });
  }
  async thumbnail(id: string, request: ImageRequest = {}) {
    const release = this.inFlight.enter(id);
    try {
      const file = await this.ready(id);
      const result = await this.derived.thumbnail(file);
      const headers = imageHeaders(
        this.config,
        "image/webp",
        `W/"thumbnail-${result.cacheIdentity}"`,
        "stream" in result ? result.size : result.bytes.byteLength,
      );
      // This is an authenticated API response, not a public image URL.
      headers.set("cache-control", "private, no-cache, must-revalidate");
      return await derivedImageResponse(result, request, headers);
    } finally {
      release();
    }
  }
  async access(
    file: FileRecord,
    params: Query,
    signal: AbortSignal,
    request: ImageRequest = {},
  ) {
    const release = this.inFlight.enter(file.id);
    let transferred = false;
    try {
      file = await this.ready(file.id);
      const ctx = this.context(signal);
      const original = async () => {
        const result = await this.read(file, "auto", ctx);
        try {
          await this.ready(file.id);
        } catch (error) {
          if (result.type === "stream") await result.stream.cancel();
          throw error;
        }
        if (result.type === "redirect") {
          const url = new URL(result.url);
          const now = Date.now();
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            (result.expiresAt !== undefined &&
              (!Number.isFinite(result.expiresAt) || result.expiresAt <= now))
          )
            throw new AppError("PLUGIN_RESULT", "Invalid redirect", 502);
          return new Response(null, {
            status: 302,
            headers: {
              location: url.href,
              "cache-control": publicCacheControl(
                this.config,
                result.expiresAt === undefined
                  ? undefined
                  : Math.floor((result.expiresAt - now) / 1000),
              ),
            },
          });
        }
        const headers = imageHeaders(
          this.config,
          file.mime_type ??
            imageMimeFromKey(file.logical_key) ??
            "application/octet-stream",
          `W/"original-${file.id}"`,
          file.byte_size,
        );
        const empty = emptyImageResponse(request, headers);
        if (empty) {
          await result.stream.cancel();
          return empty;
        }
        transferred = true;
        return new Response(retainStream(result.stream, release, signal), {
          headers,
        });
      };

      const steps = this.acquireSteps(
        await this.db.read(async (r) => {
          const p = await r.accessPipeline();
          return p ? r.steps(p.id) : [];
        }),
        "access",
      );
      try {
        const effective = steps.map((item) =>
          requestParameters(
            this.plugins.descriptor(item.record).paramsSchema,
            item.step.enabled_params,
            params,
          ),
        );
        if (!steps.length) return await original();
        const useCache = steps.every(
          (s) => (s.runtime as AccessPlugin).cacheable !== false,
        );
        const key = useCache
          ? await cacheKey(
              file.id,
              {
                // Invalidate transforms produced before EXIF orientation was applied.
                processingVersion: 3,
                params: effective,
                limits: {
                  maxDimension: this.config.maxDimension,
                  maxPixels: this.config.maxPixels,
                },
              },
              steps.map((item) => ({
                step: item.step,
                record: item.record,
                cacheConfig: this.plugins.cacheConfiguration(item.record),
              })),
            )
          : "";
        const result = await this.derived.render(
          file,
          key,
          useCache,
          signal,
          async (getSource, processingSignal, owned) => {
            const processed = await this.pipeline(
              "",
              {
                mimeType: file.mime_type,
                byteSize: file.byte_size,
                width: file.width,
                height: file.height,
              },
              effective,
              steps,
              this.context(processingSignal),
              owned,
              async () => {
                const path = await getSource();
                return {
                  path,
                  metadata: await this.derived.identifyOriginal(
                    file,
                    path,
                    processingSignal,
                  ),
                };
              },
            );
            if (!processed.loaded) return null;
            return {
              bytes: new Uint8Array(
                await Bun.file(processed.path).arrayBuffer(),
              ),
              metadata: processed.metadata,
            };
          },
        );
        if (!result) return await original();
        const headers = imageHeaders(
          this.config,
          result.metadata.mimeType!,
          useCache && result.cacheIdentity
            ? `W/"processed-${result.cacheIdentity}"`
            : undefined,
          "stream" in result ? result.size : result.bytes.byteLength,
        );
        return await derivedImageResponse(result, request, headers);
      } finally {
        for (const step of steps) await step.release();
      }
    } finally {
      if (!transferred) release();
    }
  }
  async deleteMany(
    ids: string[],
    identity?: Identity,
    scope?: { sourceId: string; includeLast: boolean },
  ): Promise<import("../../shared/api").BatchDeleteResult> {
    const results: import("../../shared/api").BatchDeleteResult["results"] = [];
    for (const id of ids) {
      try {
        if (scope) {
          if (identity) this.auth.requireAdmin(identity);
          const replica = (await this.db.read((r) => r.replicas(id))).find(
            (r) => r.storage_instance_id === scope.sourceId,
          );
          await this.deleteReplica(
            id,
            requireValue(replica).id,
            scope.includeLast,
          );
        } else await this.delete(id, identity);
        results.push({ id, accepted: true });
      } catch (e) {
        results.push({
          id,
          accepted: false,
          error: e instanceof AppError ? e.code : "INTERNAL",
        });
      }
    }
    return { results };
  }
  async deleteReplica(fileId: string, replicaId: string, includeLast = false) {
    let deletingFile = false;
    await this.db.transaction(async (r) => {
      const file = requireValue(await r.file(fileId));
      const replica = requireValue(await r.replica(replicaId));
      if (replica.file_id !== fileId)
        throw new AppError("NOT_FOUND", "Replica not found", 404);
      if (
        ["deleting", "deleted"].includes(file.status) ||
        [
          "deleted",
          "delete_pending",
          "deleting",
          "delete_failed",
          "delete_unknown",
        ].includes(replica.status)
      )
        return;
      if (!["ready", "blocked"].includes(file.status))
        throw new Conflict("File is not available");
      const tasks = await r.tasks(fileId);
      if (
        ["writing", "write_unknown"].includes(replica.status) ||
        tasks.some((t) => t.replica_id === replicaId && t.status === "running")
      )
        throw new Conflict("Replica has an active or unresolved write");
      const otherReady = (await r.replicas(fileId)).some(
        (r) => r.id !== replicaId && r.status === "ready",
      );
      if (!otherReady) {
        if (!includeLast)
          throw new AppError(
            "LAST_REPLICA",
            "This is the last available replica. Choose whole-image deletion to continue.",
            409,
          );
        const previous = file.status;
        file.status = "deleting";
        await r.saveFile(file, previous);
        deletingFile = true;
        return;
      }
      for (const task of tasks)
        if (
          task.replica_id === replicaId &&
          task.kind === "write" &&
          ["pending", "failed"].includes(task.status)
        ) {
          task.status = "cancelled";
          task.next_run_at = null;
          task.last_error = null;
          await r.saveTask(task);
        }
      if (["pending", "write_failed"].includes(replica.status)) {
        replica.status = "deleted";
      } else {
        replica.status = "delete_pending";
        await r.insertTask({
          ...entity(),
          kind: "delete",
          file_id: fileId,
          replica_id: replicaId,
          pipeline_id: null,
          status: "pending",
          attempts: 0,
          next_run_at: Date.now(),
          last_error: null,
        });
      }
      await r.saveReplica(replica);
    });
    if (deletingFile) this.tasks.cancel(fileId);
  }
  async delete(id: string, identity?: Identity) {
    await this.db.transaction(async (r) => {
      const f = requireValue(await r.file(id));
      if (identity) this.auth.assertFile(identity, f);
      if (f.status === "deleted" || f.status === "deleting") return;
      const previous = f.status;
      f.status = "deleting";
      await r.saveFile(f, previous);
    });
    this.tasks.cancel(id);
  }
  async sweep() {
    await this.tasks.sweep();
  }
  async recover() {
    await this.temporary.recover();
    await this.db.transaction(async (r) => {
      await r.recoverTasks();
      for (const f of await r.filesInStates(["preparing"])) {
        f.status = "failed";
        f.last_error = "INTERRUPTED_UPLOAD";
        await r.saveFile(f, "preparing");
      }
    });
    await this.sweep();
    const known = new Set(
      (
        await this.db.read((r) =>
          r.filesInStates([
            "preparing",
            "ready",
            "blocked",
            "failed",
            "deleting",
            "deleted",
          ]),
        )
      ).map((f) => f.temp_path),
    );
    for (const name of await readdir(join(this.config.root, "temp")))
      if (!known.has(name))
        await this.temporary.remove(join(this.config.root, "temp", name));
    await this.cache.clean();
  }
  async close() {
    await this.tasks.close();
    await this.inFlight.drain();
  }
}
