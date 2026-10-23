import { SourceCleanups } from "./core/source-cleanups";
import { initialConfig } from "../shared/config";
import { Themes } from "./themes/manager";
import { reservedPrefix } from "../shared/web-routes";
import { Imports } from "./core/import";
import { Uploads } from "./core/uploads";
import { SystemMonitor } from "./core/system-status";
import { DeliveryConfiguration } from "./core/delivery-settings";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { settings, type Settings } from "./config";
import { openPersistence } from "./persistence/open";
import { Secrets } from "./infra/secrets";
import { workLock, prefix } from "./infra/files";
import { PluginManager } from "./plugins/manager";
import { datePath } from "./builtins/path/date-path/index";
import { randomPath } from "./builtins/path/random-path/index";
import { localStorage } from "./builtins/storage/local/index";
import { watermark } from "./builtins/processor/watermark/index";
import { sharpProcessor } from "./builtins/processor/sharp/index";
import { Auth } from "./core/auth";
import { Files, type Faults } from "./core/files";
import { entity, type Persistence } from "./persistence/port";
import { telegramNotification } from "./builtins/processor/telegram-notification/index";
import { webdavStorage } from "./builtins/storage/webdav/index";
import { s3Storage } from "./builtins/storage/s3/index";
import { Configuration } from "./core/configuration";
import { PluginPackages } from "./plugins/packages";
export async function bootstrap(
  overrides: Partial<Settings> = {},
  faults: Faults = {},
  lifecycle: { lock?: boolean } = {},
) {
  const config = settings(overrides);
  const unlock =
    lifecycle.lock === false ? async () => {} : await workLock(config.root);
  let db: Persistence | undefined;
  try {
    for (const name of ["originals", "temp", "cache", "plugins"])
      await mkdir(join(config.root, name), { recursive: true });
    db = await openPersistence(config);
    await db.transaction(async (r) => {
      if (!(await r.accessPipeline()))
        await r.insertPipeline({
          ...entity(),
          name: "Access pipeline",
          kind: "access",
          config_version: 1,
        });
    });
    const webConflict = (await db.read((r) => r.prefixes())).some(
      reservedPrefix,
    );
    if (webConflict)
      console.error(
        JSON.stringify({
          event: "web_prefix_conflict",
          message:
            "Web UI disabled: existing image prefix overlaps a reserved route",
        }),
      );
    const plugins = new PluginManager(
      db,
      new Secrets(config.encryptionKey),
      config.root,
    );
    plugins.register(datePath);
    plugins.register(randomPath);
    plugins.register(localStorage);
    plugins.register(sharpProcessor);
    plugins.register(watermark);
    plugins.register(s3Storage);
    plugins.register(telegramNotification);
    plugins.register(webdavStorage);
    const packages = new PluginPackages(
      join(config.root, "plugins"),
      plugins,
      db,
    );
    const system = new SystemMonitor(
      db,
      config.root,
      config.databaseUrl ? "postgres" : "sqlite",
      plugins,
    );
    const auth = new Auth(db, config);
    const files = new Files(db, plugins, auth, config, faults);
    let runtimeReady = false;
    const delivery = new DeliveryConfiguration(config, (value) => {
      files.cache.configure(value.cacheBytes, value.cacheTtlMs);
      files.configureProcessing(
        value.processingConcurrency,
        value.processingQueue,
      );
      if (runtimeReady)
        void files.tasks.dispatch().catch(() => {
          console.error(JSON.stringify({ event: "task_dispatch_failed" }));
        });
    });
    await delivery.load();
    const themes = new Themes(config.root, delivery.store);
    await themes.start();
    await packages.start();
    await plugins.start();
    const configuration = new Configuration(db, plugins, files);
    await files.recover();
    const uploads = new Uploads(db, files, auth, config);
    await uploads.recover();
    runtimeReady = true;
    let closed = false;
    return {
      config,
      delivery,
      themes,
      system,
      webConflict,
      db: db as Persistence,
      plugins,
      packages,
      auth,
      files,
      uploads,
      cleanups: new SourceCleanups(db, files),
      configuration,
      imports: new Imports(db, plugins),
      async close() {
        if (closed) return;
        closed = true;
        await system.close();
        await delivery.close();
        await themes.close();
        await files.tasks.close();
        await uploads.close();
        await files.close();
        await plugins.close();
        await db!.close();
        await unlock();
      },
    };
  } catch (e) {
    await db?.close();
    await unlock();
    throw e;
  }
}
export type Application = Awaited<ReturnType<typeof bootstrap>>;
export async function initializeDevelopment(app: Application) {
  return initializeUploadDefaults(app, true);
}
export async function initializeUploadDefaults(
  app: Application,
  development = false,
) {
  const existing = await app.db.read((r) => r.profiles());
  if (existing.length) return existing[0]!.id;
  const ensure = async (
    pluginId: string,
    name: string,
    config: Record<string, string | number>,
  ) => {
    const old = (await app.db.read((r) => r.instances())).find(
      (x) => x.plugin_id === pluginId && x.name === name,
    );
    return (
      old ??
      app.plugins.save({
        pluginId,
        version: "1.0.0",
        name,
        config: {
          ...initialConfig(
            app.plugins.descriptor({
              plugin_id: pluginId,
              plugin_version: "1.0.0",
              stage: pluginId === "builtin.sharp" ? "access" : null,
            }).configSchema,
          ),
          ...config,
        },
        stage: pluginId === "builtin.sharp" ? "access" : undefined,
      })
    );
  };
  const path = await ensure(
    "builtin.random-path",
    development ? "Default random path" : "Default",
    {},
  );
  const storage = await ensure(
    "builtin.local",
    development ? "Default local storage" : "Default",
    {
      root: development ? join(app.config.root, "originals") : "./images",
    },
  );
  const needsProcessor = await app.db.read(async (r) => {
    const access = (await r.accessPipeline())!;
    return access.config_version === 1 && !(await r.steps(access.id)).length;
  });
  const processor =
    development && needsProcessor
      ? await ensure("builtin.sharp", "Default image transform", {})
      : null;
  for (const x of [path, storage, ...(processor ? [processor] : [])]) {
    const lease = app.plugins.acquire(
      x.id,
      x.kind === "processor" ? x.stage! : x.kind,
    );
    await lease.release();
  }
  return app.db.transaction(async (r) => {
    const profiles = await r.profiles();
    if (profiles.length) return profiles[0]!.id;
    const group = {
      ...entity(),
      name: development ? "Local" : "Default",
      selection_strategy: "priority" as const,
      replica_count: 1,
      config_version: 1,
    };
    await r.insertGroup(group);
    await r.insertMember(group.id, storage.id, 0, 1);
    const profile = {
      ...entity(),
      name: "Default",
      is_default: true,
      public_prefix: "/i/",
      path_instance_id: path.id,
      upload_pipeline_id: null,
      post_save_pipeline_id: null,
      storage_group_id: group.id,
      enabled: true,
      config_version: 1,
      max_upload_bytes: null,
      allowed_mime_types: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/svg+xml",
      ],
    };
    prefix(profile.public_prefix);
    await r.insertProfile(profile);
    const access = (await r.accessPipeline())!;
    if (
      processor &&
      access.config_version === 1 &&
      !(await r.steps(access.id)).length
    )
      await r.insertStep({
        ...entity(),
        pipeline_id: access.id,
        enabled_params: ["w", "h", "fit", "q", "format"],
        position: 0,
        plugin_instance_id: processor.id,
        on_not_applicable: "abort",
      });
    return profile.id;
  });
}
