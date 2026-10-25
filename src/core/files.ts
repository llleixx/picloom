import { Organization } from "./organization";
import { processorOutputs } from "./processor-output";
import { checkStorageCapacity, storageHasCapacity } from "./storage-capacity";
import { TemporarySpace } from "../infra/temporary-space";
import { isPluginError } from "@picloom/plugin-sdk";
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
  type Step,
  type Task,
} from "../persistence/port";
import type { PluginManager } from "../plugins/manager";
import {
  type Context,
  type Metadata,
  type Query,
  type UploadPlugin,
  type FileContext,
  type FileInput,
} from "../plugins/api";
import { AppError, Conflict, requireValue } from "./errors";
import { InFlight, Limiter } from "./concurrency";
import {
  prefix,
  publicPathKey,
  fileInput,
  logicalKey,
  publicPath,
  retainStream,
  prefetchStream,
  sourceReadStream,
  SourceReadError,
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
  readonly organization: Organization;
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
    this.organization = new Organization(db);
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
        download: (file, path, signal) => this.download(file, path, signal),
      },
    );
    this.tasks = new TaskExecutor(
      db,
      plugins,
      config,
      this.inFlight,
      this.cache,
      this.temporary,
      this.organization,
      (file, path, signal) => this.download(file, path, signal),
      faults.beforeDelete,
      faults,
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
        runtime: UploadPlugin | AccessPlugin;
        record: ReturnType<PluginManager["acquire"]>["record"];
        release: () => Promise<void>;
      }>;
    } catch (e) {
      for (const item of result) void item.release();
      throw e;
    }
  }
  private checkResult(check: { status: string; reason?: string }, step: Step) {
    if (
      !check ||
      !["applicable", "noop", "unsupported"].includes(check.status) ||
      (check.reason !== undefined && typeof check.reason !== "string")
    )
      throw new AppError(
        "PROCESSING_RESULT_INVALID",
        "Invalid processor check result",
        500,
      );
    if (check.status === "unsupported" && step.on_not_applicable !== "skip")
      throw new AppError(
        "UNSUPPORTED",
        check.reason ?? "Processor does not support this file",
        422,
      );
    return check.status === "applicable";
  }
  private validateImageResult(
    result: unknown,
  ): asserts result is Exclude<
    import("../plugins/api").UploadResult,
    { status: "reject" }
  > {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("status" in result) ||
      typeof result.status !== "string" ||
      !["pass", "replace", "reject"].includes(result.status)
    )
      throw new AppError(
        "PROCESSING_RESULT_INVALID",
        "Invalid processor result",
        500,
      );
    if (result.status === "reject") {
      if (!("reason" in result) || typeof result.reason !== "string")
        throw new AppError(
          "PROCESSING_RESULT_INVALID",
          "Invalid rejection",
          500,
        );
      throw new AppError("REJECTED", result.reason, 422);
    }
    if (
      result.status === "replace" &&
      (!("output" in result) ||
        !result.output ||
        typeof result.output !== "object" ||
        !("handle" in result.output) ||
        typeof result.output.handle !== "string")
    )
      throw new AppError(
        "PROCESSING_RESULT_INVALID",
        "Invalid processor output",
        500,
      );
  }
  private async processedMetadata(path: string, signal: AbortSignal) {
    const metadata = await identify(path, this.config.maxPixels, signal);
    if (
      metadata.width! > this.config.maxDimension ||
      metadata.height! > this.config.maxDimension
    )
      throw new AppError("INVALID_PARAMS", "Output exceeds dimension limit");
    return metadata;
  }
  private async uploadPipeline(
    path: string,
    metadata: Metadata,
    params: Parameters[],
    steps: ReturnType<Files["acquireSteps"]>,
    ctx: Context,
    owned: Set<string>,
    record: FileContext,
  ) {
    const data = pipelineData();
    for (const [index, item] of steps.entries()) {
      ctx.signal.throwIfAborted();
      let active = true;
      let checking = true;
      const checkCatalog = this.organization.scope(
        record.ownerId,
        ctx.signal,
        () => active && checking,
      );
      const catalog = this.organization.scope(
        record.ownerId,
        ctx.signal,
        () => active,
      );
      const scope = scopedInput(fileInput(path, metadata), ctx.signal);
      const outputs = processorOutputs(
        this.temporary,
        owned,
        this.config.maxUploadBytes,
        ctx.signal,
      );
      try {
        const runtime = item.runtime as UploadPlugin;
        const input = {
          file: scope.file,
          params: params[index]!,
          record: structuredClone(record),
          limits: {
            maxDimension: this.config.maxDimension,
            maxPixels: this.config.maxPixels,
          },
        };
        const check = await runtime.check(input, {
          ...ctx,
          data: { get: data.get },
          organization: checkCatalog.reader,
        });
        checking = false;
        if (!this.checkResult(check, item.step)) continue;
        const result = await runtime.process(
          {
            ...input,
            record: structuredClone(record),
            createOutput: outputs.createOutput,
          },
          {
            ...ctx,
            data,
            organization: catalog.writer,
          },
        );
        active = false;
        this.validateImageResult(result);
        ctx.signal.throwIfAborted();
        let nextPath = path,
          nextMetadata = metadata;
        if (result.status === "replace") {
          nextPath = await outputs.accept(result.output);
          nextMetadata = await this.processedMetadata(nextPath, ctx.signal);
        }
        const next = await this.organization.applyUpdate(
          record.ownerId,
          record.organization,
          result.organization,
        );
        path = nextPath;
        metadata = nextMetadata;
        record = { ...record, organization: next.organization };
      } catch (error) {
        if (isPluginError(error) && error.code === "INVALID_INPUT")
          throw new AppError("INVALID_PARAMS", "Invalid processor parameters");
        throw error;
      } finally {
        active = false;
        await outputs.close();
        await scope.close();
      }
    }
    return { path, metadata, record };
  }
  private async accessPipeline(
    path: string,
    metadata: Metadata,
    params: Parameters[],
    steps: ReturnType<Files["acquireSteps"]>,
    ctx: Context,
    owned: Set<string>,
    load: () => Promise<{ path: string; metadata: Metadata }>,
  ) {
    let loaded = false;
    const data = pipelineData();
    for (const [index, item] of steps.entries()) {
      ctx.signal.throwIfAborted();
      let active = true;
      let scope = loaded
        ? scopedInput(fileInput(path, metadata), ctx.signal)
        : undefined;
      let pending: Promise<FileInput> | undefined;
      const getFile = () => {
        ctx.signal.throwIfAborted();
        if (!active) throw new Error("Processor step has ended");
        return (pending ??= (async () => {
          if (!loaded) {
            ({ path, metadata } = await load());
            loaded = true;
          }
          scope ??= scopedInput(fileInput(path, metadata), ctx.signal);
          return scope.file;
        })());
      };
      const outputs = processorOutputs(
        this.temporary,
        owned,
        this.config.uploadTempBytes,
        ctx.signal,
      );
      try {
        const runtime = item.runtime as AccessPlugin;
        const input = {
          metadata: Object.freeze({ ...metadata }),
          getFile,
          params: params[index]!,
          limits: {
            maxDimension: this.config.maxDimension,
            maxPixels: this.config.maxPixels,
          },
        };
        if (
          !this.checkResult(
            await runtime.check(input, { ...ctx, data: { get: data.get } }),
            item.step,
          )
        )
          continue;
        const result = await runtime.process(
          { ...input, createOutput: outputs.createOutput },
          { ...ctx, data },
        );
        this.validateImageResult(result);
        if ("organization" in result)
          throw new AppError(
            "PROCESSING_RESULT_INVALID",
            "Access processors cannot change organization",
            500,
          );
        if (result.status === "replace") {
          path = await outputs.accept(result.output);
          metadata = await this.processedMetadata(path, ctx.signal);
          loaded = true;
        }
      } catch (error) {
        if (isPluginError(error) && error.code === "INVALID_INPUT")
          throw new AppError("INVALID_PARAMS", "Invalid processor parameters");
        throw error;
      } finally {
        active = false;
        await outputs.close();
        if (pending) await pending.catch(() => {});
        await scope?.close();
      }
    }
    return { path, metadata, loaded };
  }
  private async uploadPlan(profileId: string, bytes = 1) {
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
        if (
          this.plugins.isReady(instance.id, "storage") &&
          (await storageHasCapacity(r, instance.id, bytes))
        )
          eligible.push({
            id: instance.id,
            priority: m.priority,
            weight: m.weight,
          });
      }
      if (eligible.length < g.replica_count)
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "可用存储实例不足，无法满足副本数",
          503,
        );
      const remaining = [...eligible],
        targets: string[] = [];
      for (let n = 0; n < g.replica_count; n++) {
        const selected = selectStorage(
          remaining,
          g.selection_strategy,
          this.random,
        );
        targets.push(selected.id);
        remaining.splice(remaining.indexOf(selected), 1);
      }
      return {
        profile: p,
        targets,
        steps: p.upload_pipeline_id ? await r.steps(p.upload_pipeline_id) : [],
        actions: p.post_save_pipeline_id
          ? await r.steps(p.post_save_pipeline_id)
          : [],
      };
    });
    const leases: Array<{ release(): Promise<void> }> = [];
    try {
      leases.push(this.plugins.acquire(plan.profile.path_instance_id, "path"));
      for (const id of plan.targets)
        leases.push(this.plugins.acquire(id, "storage"));
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
    const admin =
      identity?.kind === "session" && isSiteAdmin(identity.user.role);
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
                ? "可用存储源不足，无法满足副本数"
                : "配置关联的资源或插件实例不可用";
        }
        return {
          id: p.id,
          name: p.name,
          publicPrefix: p.public_prefix,
          enabled: p.enabled,
          maxUploadBytes: Math.min(
            p.max_upload_bytes ?? Infinity,
            limits.maxBytes,
          ),
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
      size >
        Math.min(
          profile.max_upload_bytes ?? Infinity,
          this.config.maxUploadBytes,
        )
    )
      throw new AppError("TOO_LARGE", "Invalid upload size", 413);
  }
  async uploadOrganization(
    ownerId: string | null,
    value: unknown,
    options: { ignoreMissing?: boolean } = {},
  ) {
    if (ownerId === null && value !== undefined)
      throw new AppError("FORBIDDEN", "Guests cannot select organization", 403);
    return this.organization.resolve(ownerId, value, options);
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
    organization?: unknown,
    organizationValidated = false,
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
          organization,
          organizationValidated,
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
    organization?: unknown,
    organizationValidated = false,
  ) {
    const maxUploadBytes = this.config.maxUploadBytes;
    await this.auth.authorizeUpload(identity, profileId);
    await this.auth.checkUploadQuota(identity, blob.size, guestIp);
    const plan = await this.uploadPlan(profileId, blob.size);
    if (
      blob.size === 0 ||
      blob.size >
        Math.min(plan.profile.max_upload_bytes ?? Infinity, maxUploadBytes)
    )
      throw new AppError("TOO_LARGE", "Invalid upload size", 413);
    const ownerId = this.auth.uploadOwner(identity).ownerId;
    const initialOrganization = await this.uploadOrganization(
      ownerId,
      organization,
      { ignoreMissing: organizationValidated },
    );
    const base = { ...entity(), ...(fileId ? { id: fileId } : {}) };
    const initialRecord: FileContext = {
      id: base.id,
      createdAt: base.created_at,
      ownerId,
      origin: { kind: "upload", userId: ownerId },
      organization: initialOrganization,
    };
    const end = this.inFlight.enter(base.id);
    const owned = new Set<string>();
    if (prepared) {
      owned.add(prepared.path);
      prepared.adopted = true;
    }
    let record: FileRecord | undefined;
    let published = false;
    const replicas = plan.targets.map((id) => ({
      ...entity(),
      file_id: base.id,
      storage_instance_id: id,
      status: "pending" as const,
      locator_json: null,
    }));
    let pathLease:
      | {
          runtime: import("../plugins/api").PathPlugin;
          release: () => Promise<void>;
        }
      | undefined;
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
      const temp = prepared?.path ?? this.temp();
      owned.add(temp);
      if (!prepared) {
        this.temporary.reserve(temp, blob.size);
        await this.temporary.write(
          temp,
          blob.stream(),
          Math.min(plan.profile.max_upload_bytes ?? Infinity, maxUploadBytes),
          signal,
        );
      }
      const current = await this.limit.run(async () => {
        signal.throwIfAborted();
        const metadata = await identify(temp, this.config.maxPixels, signal);
        if (!plan.profile.allowed_mime_types.includes(metadata.mimeType!))
          throw new AppError("UNSUPPORTED", "Upload type not allowed", 415);
        return this.uploadPipeline(
          temp,
          metadata,
          effective,
          chain,
          ctx,
          owned,
          initialRecord,
        );
      }, signal);
      if (current.metadata.byteSize! > maxUploadBytes)
        throw new AppError("TOO_LARGE", "Processed upload exceeds limit", 413);
      if (
        !plan.profile.allowed_mime_types.includes(current.metadata.mimeType!) ||
        current.metadata.byteSize! > (plan.profile.max_upload_bytes ?? Infinity)
      )
        throw new AppError(
          "UNSUPPORTED",
          "Final image exceeds upload policy",
          415,
        );
      const generated = await pathLease.runtime.generate(
        {
          record: structuredClone(current.record),
          metadata: current.metadata,
          originalName: blob.name.split(/[\\/]/).pop(),
        },
        ctx,
      );
      const key = logicalKey(generated.logicalKey);
      const storageKey = logicalKey(generated.storageKey ?? key);
      record = {
        ...base,
        guest_ip: ownerId ? null : guestIp,
        owner_id: ownerId,
        origin_kind: "upload",
        origin_user_id: ownerId,
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
        processing_results_json: null,
      };
      signal.throwIfAborted();
      await this.db.transaction(async (r) => {
        prefix(record!.public_prefix);
        for (const id of plan.targets)
          await checkStorageCapacity(r, id, record!.byte_size!);
        await r.insertFile(record!);
        await this.organization.write(
          r,
          base.id,
          ownerId,
          {
            tagIds: current.record.organization.tags.map((x) => x.id),
            collectionIds: current.record.organization.collections.map(
              (x) => x.id,
            ),
          },
          { ignoreMissing: true },
        );
        for (const replica of replicas) {
          await r.insertReplica(replica);
          await r.insertTask({
            ...entity(),
            kind: "write",
            file_id: base.id,
            replica_id: replica.id,
            pipeline_id: null,
            status: "pending",
            attempts: 0,
            next_run_at: Date.now(),
            last_error: null,
          });
        }
      });
      owned.delete(current.path);
      await this.tasks.waitForFirstWrite(base.id, signal);
      await this.faults.beforePublish?.();
      signal.throwIfAborted();
      await this.db.transaction(async (r) => {
        signal.throwIfAborted();
        const file = requireValue(await r.file(base.id));
        if (file.status !== "preparing")
          throw new Conflict("Upload is no longer preparing");
        if (
          !(await r.replicas(base.id)).some(
            (replica) => replica.status === "ready",
          )
        )
          throw new AppError("UPLOAD_FAILED", "No available copy", 502);
        await this.auth.recordSuccessfulUpload(identity, guestIp, r);
        record!.status = "ready";
        await r.saveFile(record!, "preparing");
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
      // Publication unlocks retries and post-save work. Existing writes keep running.
      void this.tasks.dispatch().catch(() => {
        console.error(JSON.stringify({ event: "task_dispatch_failed" }));
      });
      return {
        id: base.id,
        url: this.config.imageOrigin + publicPath(record.public_prefix, key),
      };
    } catch (e) {
      if (record && !published) {
        await this.db.transaction(async (r) => {
          const f = await r.file(base.id);
          if (!f) return;
          if (f.status !== "preparing") return;
          f.status = "failed";
          f.last_error = e instanceof AppError ? e.code : "UPLOAD_FAILED";
          await r.saveFile(f, "preparing");
        });
        this.tasks.cancel(base.id);
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
  private async download(file: FileRecord, path: string, signal: AbortSignal) {
    await this.read(file, "stream", this.context(signal), async (stream) => {
      const source = sourceReadStream(stream);
      try {
        const size = await this.temporary.write(
          path,
          source,
          file.byte_size ?? this.config.uploadTempBytes,
          signal,
        );
        if (file.byte_size !== null && size !== file.byte_size)
          throw new SourceReadError();
      } catch (error) {
        await this.temporary.remove(path);
        throw error;
      } finally {
        await source.cancel().catch(() => {});
      }
    });
  }
  private async read(
    file: FileRecord,
    mode: "auto" | "stream",
    ctx: Context,
    consume?: (stream: ReadableStream<Uint8Array>) => Promise<void>,
  ) {
    const { remaining, strategy } = await this.db.read(async (r) => {
      const ready = (await r.replicas(file.id)).filter(
        (r) => r.status === "ready",
      );
      if (!ready.length)
        throw new AppError("UNAVAILABLE", "No ready replica", 503);
      const group = file.storage_group_id
        ? await r.group(file.storage_group_id)
        : null;
      const members = group ? await r.members(group.id) : [];
      const byInstance = new Map(
        members.map((member) => [member.storage_instance_id, member]),
      );
      return {
        strategy: group?.selection_strategy ?? "weighted_random",
        remaining: ready.map((replica) => ({
          replica,
          priority:
            byInstance.get(replica.storage_instance_id)?.priority ??
            Number.MAX_SAFE_INTEGER,
          weight: byInstance.get(replica.storage_instance_id)?.weight ?? 1,
        })),
      };
    });
    while (remaining.length) {
      ctx.signal.throwIfAborted();
      const selected = selectStorage(remaining, strategy, this.random);
      remaining.splice(remaining.indexOf(selected), 1);
      let lease: ReturnType<PluginManager["acquire"]> | undefined;
      let consuming = false;
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
          const retained = retainStream(stream, storage.release, ctx.signal);
          if (consume) {
            consuming = true;
            try {
              await consume(retained);
            } finally {
              await retained.cancel().catch(() => {});
            }
          }
          return { ...result, stream: retained };
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
        if (consuming && !(error instanceof SourceReadError)) throw error;
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
            const processed = await this.accessPipeline(
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
  async terminateReplica(fileId: string, replicaId: string) {
    await this.tasks.terminateReplica(fileId, replicaId);
  }

  async detach(id: string, replicaId?: string, includeLast = true) {
    return this.tasks.detach(id, replicaId, includeLast);
  }
  async detachMany(
    ids: string[],
    identity?: Identity,
    scope?: { sourceId: string; includeLast: boolean },
  ) {
    if (identity) this.auth.requireAdmin(identity);
    const results: import("../../shared/api").BatchDeleteResult["results"] = [];
    for (const id of ids) {
      try {
        const replica = scope
          ? requireValue(
              (await this.db.read((r) => r.replicas(id))).find(
                (r) => r.storage_instance_id === scope.sourceId,
              ),
            )
          : undefined;
        await this.detach(id, replica?.id, scope?.includeLast);
        results.push({ id, accepted: true });
      } catch (error) {
        results.push({
          id,
          accepted: false,
          error: error instanceof AppError ? error.code : "INTERNAL",
        });
      }
    }
    return { results };
  }
  async deleteReplica(fileId: string, replicaId: string, includeLast = true) {
    let deletingFile = false;
    await this.tasks.manage(fileId, async (r) => {
      const file = requireValue(await r.file(fileId));
      const replica = requireValue(await r.replica(replicaId));
      if (replica.file_id !== fileId)
        throw new AppError("NOT_FOUND", "Replica not found", 404);
      if (
        ["deleting", "deleted"].includes(file.status) ||
        ["deleted", "delete_pending", "deleting", "delete_failed"].includes(
          replica.status,
        )
      )
        return;
      if (!["ready", "blocked"].includes(file.status))
        throw new Conflict("File is not available");
      const tasks = await r.tasks(fileId);
      if (
        replica.status === "writing" ||
        tasks.some((t) => t.replica_id === replicaId && t.status === "running")
      )
        throw new Conflict("Replica has a running task");
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
      if (replica.status === "pending") {
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
    return { whole: deletingFile };
  }
  async replace(
    id: string,
    replacementId: string,
    replacementPath: string,
    identity: Identity,
  ) {
    return this.db.transaction(async (r) => {
      const current = await this.auth.verify(r, identity.kind, identity.hash);
      if (current.kind !== "session")
        throw new AppError("FORBIDDEN", "Session required", 403);
      const old = requireValue(await r.file(id));
      const next = requireValue(await r.file(replacementId));
      this.auth.assertFile(current, old);
      this.auth.assertFile(current, next);
      if (
        old.id === next.id ||
        old.status !== "ready" ||
        next.status !== "ready" ||
        publicPath(next.public_prefix, next.logical_key) !== replacementPath
      )
        throw new Conflict("Images changed or are not ready");
      if (!next.upload_profile_id)
        throw new Conflict("Upload profile unavailable");
      await this.auth.authorizeUpload(current, next.upload_profile_id, r);
      if (!(await r.profile(next.upload_profile_id))?.enabled)
        throw new Conflict("Upload profile unavailable");
      if (!old.mime_type || old.mime_type !== next.mime_type)
        throw new AppError(
          "REPLACEMENT_FORMAT",
          "Replacement must have the same image format",
        );
      for (const file of [old, next]) {
        const replicas = await r.replicas(file.id);
        const deletedReplicas = new Set(
          replicas
            .filter((replica) => replica.status === "deleted")
            .map((replica) => replica.id),
        );
        if (
          !replicas.some((replica) => replica.status === "ready") ||
          replicas.some(
            (replica) => !["ready", "deleted"].includes(replica.status),
          ) ||
          (await r.tasks(file.id)).some(
            (task) =>
              task.status !== "success" &&
              !(
                (task.status === "failed" || task.status === "cancelled") &&
                task.replica_id !== null &&
                deletedReplicas.has(task.replica_id)
              ),
          )
        )
          throw new AppError(
            "REPLACEMENT_BUSY",
            "Image background operations must finish successfully first",
            409,
          );
      }
      const path = publicPath(old.public_prefix, old.logical_key);
      next.public_prefix = old.public_prefix;
      next.logical_key = old.logical_key;
      next.owner_id = old.owner_id;
      next.guest_ip = old.guest_ip;
      // Free the unique public path in the same transaction; storage keys stay intact.
      old.logical_key = `.replaced/${crypto.randomUUID()}`;
      old.status = "deleting";
      await r.saveFile(old, "ready");
      await r.saveFile(next, "ready");
      await this.organization.transfer(r, old.id, next.id);
      return { id: next.id, path };
    });
  }
  async delete(id: string, identity?: Identity) {
    await this.db.transaction(async (r) => {
      const f = requireValue(await r.file(id));
      if (identity) this.auth.assertFile(identity, f);
      if (f.status === "deleted" || f.status === "deleting") return;
      if (f.status === "delete_failed")
        throw new Conflict(
          "Retry the failed deletion task or terminate its replica",
        );
      const previous = f.status;
      f.status = "deleting";
      f.last_error = null;
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
      await r.recoverTasks(this.config.retryLimit);
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
            "delete_failed",
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
