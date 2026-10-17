import { taskFailure } from "../core/errors";
import type { Application } from "../bootstrap";
import { AppError, requireValue } from "../core/errors";
import type { Config } from "../plugins/api";
import type {
  SecretEdit,
  GroupView,
  ProfileView,
  OperationsView,
} from "../../shared/config";
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
function strings(body: Record<string, unknown>, keys: string[]) {
  for (const key of keys)
    if (typeof body[key] !== "string")
      throw new AppError("INVALID_INPUT", "字段无效：" + key);
}
export async function configurationRequest(
  app: Application,
  path: string,
  method: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<Response | null> {
  if (path === "/api/plugins" && method === "GET")
    return json(
      (await app.packages.list()).filter((p) => p.status === "loaded"),
    );
  if (path === "/api/plugin-packages" && method === "GET")
    return json(await app.packages.list());
  if (path === "/api/plugins/install" && method === "POST") {
    const b = await body();
    strings(b, ["ticket"]);
    return json(
      await app.packages.install(b.ticket as string, b.confirmTrusted === true),
      201,
    );
  }
  const staged = path.match(/^\/api\/plugins\/staged\/([a-f0-9-]+)$/);
  if (staged && method === "DELETE") {
    await app.packages.cancel(staged[1]!);
    return json({ ok: true });
  }
  const packageRoute = path.match(
    /^\/api\/plugins\/([^/]+)\/versions\/([^/]+)(?:\/(reload))?$/,
  );
  if (packageRoute) {
    const id = decodeURIComponent(packageRoute[1]!),
      version = decodeURIComponent(packageRoute[2]!);
    if (packageRoute[3] && method === "POST")
      return json(await app.packages.reload(id, version));
    if (!packageRoute[3] && method === "DELETE") {
      await app.packages.uninstall(id, version);
      return json({ ok: true });
    }
  }
  const definition = path.match(/^\/api\/plugins\/([^/]+)\/versions\/([^/]+)$/);
  if (definition && method === "GET")
    return json(
      requireValue(
        app.plugins
          .definitionsView()
          .find(
            (d) =>
              d.id === decodeURIComponent(definition[1]!) &&
              d.version === decodeURIComponent(definition[2]!),
          ),
      ),
    );
  const usages = path.match(/^\/api\/plugins\/([^/]+)\/configurations$/);
  if (usages && method === "GET")
    return json(
      await app.configuration.pluginUsages(decodeURIComponent(usages[1]!)),
    );
  const upgrade = path.match(
    /^\/api\/plugin-configurations\/([^/]+)\/upgrade-preview$/,
  );
  if (upgrade && method === "POST") {
    const b = await body();
    strings(b, ["version"]);
    return json(
      await app.plugins.previewUpgrade(upgrade[1]!, b.version as string),
    );
  }
  const reveal = path.match(
    /^\/api\/plugin-configurations\/([^/]+)\/reveal-secret$/,
  );
  if (reveal && method === "POST") {
    const b = await body();
    strings(b, ["path"]);
    return json({
      value: await app.plugins.revealSecret(reveal[1]!, b.path as string),
    });
  }
  const instances = path.match(
    /^\/api\/storage-sources(?:\/([^/]+))?(?:\/(reinitialize))?$/,
  );
  if (instances) {
    const id = instances[1];
    if (id && (await app.db.read((r) => r.instance(id)))?.kind !== "storage")
      throw new AppError("NOT_FOUND", "存储源不存在", 404);
    if (instances[2] && method === "POST" && id)
      return json(await app.plugins.reinitialize(id));
    if (!instances[2] && method === "GET")
      return json(
        id
          ? await app.plugins.view(id)
          : await Promise.all(
              (await app.db.read((r) => r.instances()))
                .filter((i) => i.kind === "storage")
                .map((i) => app.plugins.view(i.id)),
            ),
      );
    if (
      !instances[2] &&
      ((!id && method === "POST") || (id && method === "PUT"))
    ) {
      const b = await body();
      strings(b, ["pluginId", "version", "name"]);
      if (
        !b.config ||
        typeof b.config !== "object" ||
        Array.isArray(b.config) ||
        (b.secretEdits !== undefined &&
          (!b.secretEdits ||
            typeof b.secretEdits !== "object" ||
            Array.isArray(b.secretEdits)))
      )
        throw new AppError("INVALID_INPUT", "配置必须为对象");
      const definition = app.plugins
        .definitionsView()
        .find((d) => d.id === b.pluginId && d.version === b.version);
      if (definition?.kind !== "storage")
        throw new AppError("INVALID_INPUT", "这里只能创建存储源");
      const value = await app.plugins.save({
        id,
        pluginId: b.pluginId as string,
        version: b.version as string,
        name: b.name as string,
        config: b.config as Config,
        secretEdits: b.secretEdits as Record<string, SecretEdit> | undefined,
        expectedVersion: b.expectedVersion as number | undefined,
        upgrade: b.upgrade as
          | import("../../shared/config").UpgradeIntent
          | undefined,
      });
      return json(await app.plugins.view(value.id), id ? 200 : 201);
    }
    if (id && !instances[2] && method === "DELETE") {
      await app.plugins.remove(id);
      return json({ ok: true });
    }
  }
  const group = path.match(/^\/api\/storage-groups(?:\/([^/]+))?$/);
  if (group) {
    const id = group[1];
    if (method === "GET")
      return json(
        id
          ? await app.configuration.group(id)
          : await app.configuration.groups(),
      );
    if ((!id && method === "POST") || (id && method === "PUT")) {
      const b = await body();
      strings(b, ["name", "primaryStrategy", "redundancyStrategy"]);
      return json(
        await app.configuration.saveGroup(b as unknown as GroupView, id),
        id ? 200 : 201,
      );
    }
    if (id && method === "DELETE") {
      await app.configuration.deleteGroup(id);
      return json({ ok: true });
    }
  }
  const profile = path.match(/^\/api\/upload-profiles(?:\/([^/]+))?$/);
  if (profile) {
    const id = profile[1];
    if (id && method === "GET")
      return json(await app.configuration.profileEditor(id));
    if ((!id && method === "POST") || (id && method === "PUT")) {
      const b = await body();
      strings(b, ["name", "publicPrefix", "storageGroupId"]);
      return json(
        await app.configuration.saveProfileEditor(
          b as unknown as import("../../shared/config").ProfileEditor,
          id,
        ),
        id ? 200 : 201,
      );
    }
    if (id && method === "DELETE") {
      await app.configuration.deleteProfile(id);
      return json({ ok: true });
    }
  }
  const pipeline = path.match(
    /^\/api\/pipelines(?:\/([^/]+))?(?:\/(duplicate))?$/,
  );
  if (pipeline) {
    const id = pipeline[1];
    if (pipeline[2] && id && method === "POST")
      return json(await app.configuration.duplicatePipeline(id), 201);
    if (!pipeline[2]) {
      if (method === "GET")
        return json(
          id
            ? await app.configuration.pipeline(id)
            : await app.configuration.pipelines(),
        );
      if ((!id && method === "POST") || (id && method === "PUT"))
        return json(
          await app.configuration.savePipeline(
            (await body()) as unknown as import("../../shared/config").PipelineInput,
            id,
          ),
          id ? 200 : 201,
        );
      if (id && method === "DELETE") {
        await app.configuration.deletePipeline(id);
        return json({ ok: true });
      }
    }
  }
  const operations = path.match(/^\/api\/files\/([^/]+)\/operations$/);
  if (operations && method === "GET") {
    const id = operations[1]!;
    const data: OperationsView = await app.db.read(async (r) => {
      requireValue(await r.file(id));
      const replicas = await r.replicas(id),
        tasks = await r.tasks(id);
      return {
        replicas: await Promise.all(
          replicas.map(async (x) => ({
            id: x.id,
            instanceId: x.storage_instance_id,
            name:
              (await r.instance(x.storage_instance_id))?.name ??
              x.storage_instance_id,
            role: x.role,
            status: x.status,
          })),
        ),
        tasks: tasks.map((t) => {
          const failure = taskFailure(t.last_error);
          return {
            id: t.id,
            kind: t.kind,
            status: t.status,
            attempts: t.attempts,
            error: failure.code,
            failedStep: failure.step,
            pipelineId: t.pipeline_id,
          };
        }),
      };
    });
    return json(data);
  }
  const task = path.match(/^\/api\/tasks\/([^/]+)\/(retry)$/);
  if (task && method === "POST") {
    await app.files.tasks.retry(task[1]!);
    return json({ ok: true });
  }
  return null;
}
