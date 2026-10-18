import {
  bootstrap,
  initializeUploadDefaults,
  type Application,
} from "./bootstrap";
import { settings, type Settings } from "./config";
import { handler } from "./http/app";
import { InFlight } from "./core/concurrency";
import { AppError } from "./core/errors";
import { retainStream, workLock } from "./infra/files";
import { Backups, type BackupSnapshot } from "./infra/backup";

export async function startRuntime(
  overrides: Partial<Settings> = {},
  options: {
    initialPassword?: string;
    log?: (message: string) => void;
    sweep?: boolean;
  } = {},
) {
  const base = settings(overrides);
  const unlock = await workLock(base.root);
  let app: Application;
  try {
    app = await bootstrap(base, {}, { lock: false });
    if (!(await app.db.read((r) => r.userCount())))
      await initializeUploadDefaults(app);
    const password = await app.auth.initializeOnStartup(
      options.initialPassword ?? process.env.INITIAL_OWNER_PASSWORD,
    );
    if (password)
      (options.log ?? console.info)(
        `Initial Owner: admin\nInitial password: ${password}\nSave this password; it is shown only once.`,
      );
  } catch (e) {
    await app!?.close();
    await unlock();
    throw e;
  }
  let serve = handler(app),
    maintenance = false,
    stopped = false;
  const maintenanceFlight = new InFlight();
  const active = new InFlight(),
    backups = new Backups(base.root);
  const jobs = [
    {
      run: () => app.packages.cleanup(),
      event: "plugin_stage_cleanup_failed",
      running: false,
    },
    {
      run: () => app.files.tasks.dispatch(),
      event: "task_dispatch_failed",
      running: false,
    },
    {
      run: () => app.files.tasks.cleanupPending(),
      event: "task_cleanup_failed",
      running: false,
    },
    {
      run: () => app.files.temporary.clean(),
      event: "temp_cleanup_failed",
      running: false,
    },
    {
      run: () => app.uploads.cleanup(),
      event: "upload_cleanup_failed",
      running: false,
    },
    {
      run: () => app.files.cache.clean(false),
      event: "cache_cleanup_failed",
      running: false,
    },
  ];
  const timer =
    options.sweep === false
      ? undefined
      : setInterval(() => {
          if (maintenance || stopped) return;
          for (const job of jobs) {
            if (job.running) continue;
            job.running = true;
            const leave = active.enter("requests");
            void job
              .run()
              .catch(() => console.error(JSON.stringify({ event: job.event })))
              .finally(() => {
                job.running = false;
                leave();
              });
          }
        }, 2000);
  const json = (data: unknown, status = 200) =>
    Response.json(data, { status, headers: { "cache-control": "no-store" } });
  async function exclusive<T>(
    operation: (snapshot: BackupSnapshot) => Promise<T>,
    rollback?: () => Promise<void>,
  ) {
    if (maintenance || stopped)
      throw new AppError("MAINTENANCE", "Maintenance in progress", 503);
    maintenance = true;
    const finish = maintenanceFlight.enter("maintenance");
    let closed = false;
    try {
      await app.files.tasks.pause();
      await active.drain();
      await app.files.tasks.drain();
      const sources = await app.db.read((r) => r.instances());
      const snapshot: BackupSnapshot = {
        root: base.root,
        encryptionKey: base.encryptionKey,
        delivery: app.delivery.get(),
        localSources: sources.flatMap((s) => {
          const directory = app.plugins.localDirectory(s);
          return directory ? [directory] : [];
        }),
      };
      await app.close();
      closed = true;
      return await operation(snapshot);
    } finally {
      try {
        if (closed) {
          try {
            app = await bootstrap(base, {}, { lock: false });
          } catch (e) {
            if (rollback) {
              await rollback();
              app = await bootstrap(base, {}, { lock: false });
              serve = handler(app);
              maintenance = false;
            }
            throw e;
          }
          serve = handler(app);
        }
        if (stopped) await app.files.tasks.pause();
        else app.files.tasks.resume();
        maintenance = false;
      } catch (e) {
        // Keep the gate closed if reopening fails; do not serve a closed database.
        console.error(JSON.stringify({ event: "maintenance_reopen_failed" }));
        throw e;
      } finally {
        finish();
      }
    }
  }
  async function backupRequest(req: Request, path: string) {
    if (
      req.headers.has("origin") &&
      req.headers.get("origin") !==
        (app.config.origin || new URL(req.url).origin)
    )
      throw new AppError("ORIGIN", "Origin not allowed", 403);
    const identity = await app.auth.authenticate(req, true);
    if (identity.user.role !== "owner")
      throw new AppError("FORBIDDEN", "Owner required", 403);
    if (base.databaseUrl)
      throw new AppError(
        "BACKUP_UNSUPPORTED",
        "Backup and restore are unavailable for PostgreSQL",
        400,
      );
    if (path === "/api/system/backups" && req.method === "GET")
      return json(await backups.list());
    if (path === "/api/system/backups" && req.method === "POST")
      return json(await exclusive((snapshot) => backups.create(snapshot)), 201);
    if (path === "/api/system/backups/upload" && req.method === "POST")
      return json(await backups.upload(req), 201);
    const match = path.match(/^\/api\/system\/backups\/([^/]+)(\/restore)?$/);
    if (match && !match[2] && req.method === "DELETE") {
      await backups.delete(match[1]!);
      return json({ ok: true });
    }
    if (match && !match[2] && req.method === "GET") {
      const path = backups.path(match[1]!);
      if (!(await Bun.file(path).exists()))
        throw new AppError("NOT_FOUND", "Backup not found", 404);
      return new Response(Bun.file(path), {
        headers: {
          "content-type": "application/gzip",
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="picloom-${match[1]}"`,
        },
      });
    }
    if (match?.[2] && req.method === "POST") {
      if (req.headers.get("x-confirm-restore") !== "restore")
        throw new AppError("INVALID_INPUT", "Restore confirmation required");
      let rollback: (() => Promise<void>) | undefined;
      await exclusive(
        async () => {
          const restored = await backups.restore(match[1]!, base.encryptionKey);
          rollback = restored.rollback;
          try {
            // Validate settings before the normal reopen can start background work.
            const { DeliveryConfiguration } =
              await import("./core/delivery-settings");
            await new DeliveryConfiguration({ ...base }, () => {}).load();
          } catch (e) {
            await restored.rollback();
            rollback = undefined;
            throw e;
          }
        },
        async () => {
          await rollback?.();
        },
      );
      return json({ ok: true });
    }
    throw new AppError("NOT_FOUND", "Not found", 404);
  }
  return {
    get app() {
      return app;
    },
    async fetch(req: Request, client = "127.0.0.1"): Promise<Response> {
      const requestId = crypto.randomUUID();
      let release: (() => void) | undefined;
      try {
        if (maintenance || stopped)
          throw new AppError("MAINTENANCE", "Maintenance in progress", 503);
        const path = new URL(req.url).pathname;
        const backup =
          path === "/api/system/backups" ||
          path.startsWith("/api/system/backups/");
        const exclusiveRequest =
          backup &&
          req.method === "POST" &&
          (path === "/api/system/backups" || path.endsWith("/restore"));
        if (!exclusiveRequest) release = active.enter("requests");
        const result = backup
          ? await backupRequest(req, path)
          : await serve(req, client);
        if (release && result.body) {
          const done = release;
          release = undefined;
          return new Response(
            retainStream(result.body, async () => done(), req.signal),
            result,
          );
        }
        return result;
      } catch (e) {
        const error =
          e instanceof AppError
            ? e
            : new AppError("BACKUP_FAILED", "Backup operation failed", 500);
        return json(
          { error: { code: error.code, message: error.message, requestId } },
          error.status,
        );
      } finally {
        release?.();
      }
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await app.files.tasks.pause();
      await maintenanceFlight.drain();
      await app.files.tasks.pause();
      await active.drain();
      await app.close();
      await unlock();
    },
  };
}
