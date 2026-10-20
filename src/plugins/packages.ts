import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { PluginManager } from "./manager";
import { archiveFiles, parseManifest, type Manifest } from "./archive";
import { AppError, Conflict, requireValue } from "../core/errors";
import type { Persistence } from "../persistence/port";
import type { PackageView, PackageInspection } from "../../shared/config";
type Installed = {
  manifest: Manifest;
  directory: string;
  error: string | null;
};
export class PluginPackages {
  private lastCleanup = Date.now();
  private installed = new Map<string, Installed>();
  private staged = new Map<
    string,
    { directory: string; manifest: Manifest; expires: number }
  >();
  constructor(
    private root: string,
    private plugins: PluginManager,
    private db: Persistence,
  ) {
    this.root = resolve(root);
  }
  private key(m: Pick<Manifest, "id" | "version">) {
    return m.id + "@" + m.version;
  }
  private async removeDirectory(path: string) {
    const target = resolve(path);
    if (!target.startsWith(this.root + sep))
      throw new Error("Invalid plugin directory");
    await rm(target, { recursive: true, force: true });
  }
  async start() {
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = join(this.root, entry.name);
      if (
        entry.name.startsWith(".staging-") ||
        entry.name.startsWith(".removed-")
      ) {
        await this.removeDirectory(directory);
        continue;
      }
      if (!(await Bun.file(join(directory, "plugin.json")).exists())) continue;
      let manifest: Manifest;
      try {
        manifest = parseManifest(
          JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")),
        );
      } catch {
        console.error(JSON.stringify({ event: "plugin_manifest_invalid" }));
        continue;
      }
      const key = this.key(manifest);
      if (this.installed.has(key)) throw new Conflict("插件目录中存在重复版本");
      this.installed.set(key, { manifest, directory, error: null });
      await this.load(this.installed.get(key)!);
    }
  }
  private async load(record: Installed) {
    try {
      await this.plugins.loadPackage(record.directory);
      record.error = null;
    } catch {
      record.error = "插件加载失败，请检查包内容与接口版本后重试";
    }
  }
  async list(): Promise<PackageView[]> {
    const instances = await this.db.read((r) => r.instances());
    const views = new Map<string, PackageView>();
    for (const def of this.plugins.definitionsView()) {
      const refs = instances
        .filter(
          (i) => i.plugin_id === def.id && i.plugin_version === def.version,
        )
        .map(({ id, name }) => ({ id, name }));
      const source = this.plugins.isBuiltin(def.id, def.version)
        ? "builtin"
        : "external";
      views.set(this.key(def), {
        id: def.id,
        defaultLocale: def.defaultLocale,
        content: def.content,
        supportedStages:
          def.kind === "processor" ? def.supportedStages : undefined,
        kind: def.kind,
        version: def.version,
        source,
        status: "loaded",
        error: null,
        instances: refs,
        canUninstall: source === "external" && !refs.length,
      });
    }
    for (const record of this.installed.values())
      if (record.error) {
        const m = record.manifest;
        const refs = instances
          .filter((i) => i.plugin_id === m.id && i.plugin_version === m.version)
          .map(({ id, name }) => ({ id, name }));
        views.set(this.key(m), {
          id: m.id,
          defaultLocale: "en-US",
          content: {},
          kind: m.kind,
          version: m.version,
          source: "external",
          status: "failed",
          error: record.error,
          instances: refs,
          canUninstall: !refs.length,
        });
      }
    return [...views.values()];
  }
  async cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 60_000) return;
    this.lastCleanup = now;
    await this.plugins.exclusive(() => this.removeExpired());
  }
  private async removeExpired() {
    const now = Date.now();
    for (const [ticket, item] of this.staged) {
      if (item.expires > now) continue;
      try {
        await this.removeDirectory(item.directory);
        this.staged.delete(ticket);
      } catch {
        // Retain failed entries for the next cleanup without blocking other packages.
        console.error(
          JSON.stringify({ event: "plugin_stage_cleanup_failed", ticket }),
        );
      }
    }
  }
  async inspect(bytes: Uint8Array): Promise<PackageInspection> {
    return this.plugins.exclusive(async () => {
      await this.removeExpired();
      if (this.staged.size >= 8)
        throw new AppError(
          "PLUGIN_STAGE_LIMIT",
          "待确认插件包过多，请取消或稍后重试",
          409,
        );
      const files = archiveFiles(bytes);
      let manifest: Manifest;
      try {
        manifest = parseManifest(
          JSON.parse(
            new TextDecoder().decode(
              requireValue(
                files.get("plugin.json"),
                "包根目录缺少 plugin.json",
              ),
            ),
          ),
        );
      } catch {
        throw new AppError(
          "PLUGIN_PACKAGE_INVALID",
          "插件清单无效，包根目录必须包含 plugin.json",
        );
      }
      if (!files.has(manifest.entry))
        throw new AppError("PLUGIN_PACKAGE_INVALID", "插件入口文件不存在");
      if ((await this.list()).some((p) => this.key(p) === this.key(manifest)))
        throw new Conflict("该插件版本已安装，不支持覆盖或升级");
      const ticket = crypto.randomUUID(),
        directory = join(this.root, ".staging-" + ticket);
      try {
        await mkdir(directory);
        for (const [name, data] of files) {
          const path = join(directory, name);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, data, { flag: "wx" });
        }
      } catch {
        await this.removeDirectory(directory);
        throw new AppError("PLUGIN_PACKAGE_INVALID", "无法展开插件包");
      }
      this.staged.set(ticket, {
        directory,
        manifest,
        expires: Date.now() + 15 * 60_000,
      });
      return {
        id: manifest.id,
        kind: manifest.kind,
        version: manifest.version,
        ticket,
        fileCount: files.size,
        expandedBytes: [...files.values()].reduce(
          (sum, b) => sum + b.length,
          0,
        ),
      };
    });
  }
  async cancel(ticket: string) {
    return this.plugins.exclusive(async () => {
      const item = this.staged.get(ticket);
      if (item) {
        await this.removeDirectory(item.directory);
        this.staged.delete(ticket);
      }
    });
  }
  async install(ticket: string, confirmed: boolean) {
    return this.plugins.exclusive(async () => {
      if (confirmed !== true)
        throw new AppError(
          "PLUGIN_CONFIRMATION_REQUIRED",
          "请确认信任插件代码",
        );
      const item = requireValue(
        this.staged.get(ticket),
        "待安装插件包不存在或已过期",
      );
      if (item.expires < Date.now()) {
        await this.removeDirectory(item.directory);
        this.staged.delete(ticket);
        throw new AppError("PLUGIN_STAGE_EXPIRED", "插件包已过期，请重新上传");
      }
      const key = this.key(item.manifest);
      if ((await this.list()).some((p) => this.key(p) === key))
        throw new Conflict("该插件版本已安装");
      const directory = join(this.root, "package-" + crypto.randomUUID());
      await rename(item.directory, directory);
      this.staged.delete(ticket);
      const record = { manifest: item.manifest, directory, error: null };
      this.installed.set(key, record);
      await this.load(record);
      return requireValue((await this.list()).find((p) => this.key(p) === key));
    });
  }
  async reload(id: string, version: string) {
    return this.plugins.exclusive(async () => {
      const record = requireValue(this.installed.get(id + "@" + version));
      if (!record.error) throw new Conflict("插件已加载，无需重试");
      await this.load(record);
      if (!record.error)
        await this.plugins.initializePackageInstances(id, version);
      return requireValue(
        (await this.list()).find((p) => p.id === id && p.version === version),
      );
    });
  }
  async uninstall(id: string, version: string) {
    return this.plugins.exclusive(async () => {
      await this.plugins.assertPackageUnused(id, version);
      const key = id + "@" + version,
        record = requireValue(this.installed.get(key));
      const removed = join(this.root, ".removed-" + crypto.randomUUID());
      await rename(record.directory, removed);
      this.plugins.forgetPackage(id, version);
      this.installed.delete(key);
      await this.removeDirectory(removed);
    });
  }
}
