import { validConfigPath } from "../plugins/local-directory";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  lstat,
  stat,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { create, extract, list } from "tar";
import type { BackupView } from "../../shared/backup";
import { AppError } from "../core/errors";
import { prepareRestoredDatabase } from "../persistence/sqlite/backup";
import packageJson from "../../package.json";
export const BACKUP_LIMIT = 5 * 1024 ** 3;
const expandedLimit = 50 * 1024 ** 3;
export interface BackupSnapshot {
  root: string;
  encryptionKey: string;
  localSources: Array<{ id: string; root: string; configPath: string }>;
}
interface Manifest {
  format: 1;
  version: string;
  createdAt: number;
  root: string;
  encryptionKey: string;
  localSources: Array<{ id: string; directory: string; configPath: string }>;
}
const invalid = () =>
  new AppError("BACKUP_INVALID", "Invalid or incompatible backup");
const inside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
};
async function copyTree(
  from: string,
  to: string,
  budget?: { bytes: number; entries: number },
) {
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (path) => {
      const info = await lstat(path);
      if (!info.isDirectory() && !info.isFile())
        throw new AppError(
          "BACKUP_SOURCE",
          "Backup only supports regular files and directories",
        );
      if (budget) {
        budget.entries++;
        budget.bytes += info.isFile() ? info.size : 0;
        if (
          budget.bytes > expandedLimit - 1024 * 1024 ||
          budget.entries > 999_990
        )
          throw new AppError("BACKUP_LIMIT", "Backup exceeds archive limits");
      }
      return true;
    },
  });
}
export class Backups {
  readonly directory: string;
  constructor(private root: string) {
    this.directory = join(dirname(root), "backups");
  }
  private async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
  path(id: string) {
    if (!/^[0-9a-f-]{36}\.tar\.gz$/.test(id)) throw invalid();
    return join(this.directory, id);
  }
  async delete(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
  }
  async list(): Promise<BackupView[]> {
    await this.init();
    const result: BackupView[] = [];
    for (const id of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.tar\.gz$/.test(id)) continue;
      const info = await lstat(this.path(id));
      if (info.isFile())
        result.push({ id, createdAt: info.mtimeMs, byteSize: info.size });
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }
  async create(snapshot: BackupSnapshot): Promise<BackupView> {
    await this.init();
    const stage = await mkdtemp(join(this.directory, ".create-"));
    const id = crypto.randomUUID() + ".tar.gz",
      temporary = this.path(id) + ".tmp";
    try {
      const data = join(stage, "data");
      const budget = { bytes: 0, entries: 0 };
      await mkdir(data);
      for (const name of [
        "database.sqlite",
        "plugins",
        "temp",
        "uploads",
        "themes",
      ])
        await copyTree(join(snapshot.root, name), join(data, name), budget);
      await copyTree(
        join(snapshot.root, "site-settings.json"),
        join(data, "site-settings.json"),
        budget,
      );
      const manifest: Manifest = {
        format: 1,
        version: packageJson.version,
        createdAt: Date.now(),
        root: snapshot.root,
        encryptionKey: snapshot.encryptionKey,
        localSources: [],
      };
      for (const source of snapshot.localSources) {
        const root = resolve(source.root);
        if (inside(root, snapshot.root) || inside(root, this.directory))
          throw new AppError(
            "BACKUP_SOURCE",
            "Local storage must not contain the application or backup directory",
          );
        const directory = "originals/" + source.id;
        await copyTree(root, join(data, directory), budget);
        manifest.localSources.push({
          id: source.id,
          directory,
          configPath: source.configPath,
        });
      }
      await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest), {
        mode: 0o600,
      });
      await create(
        {
          cwd: stage,
          file: temporary,
          gzip: true,
          portable: true,
          strict: true,
        },
        ["manifest.json", "data"],
      );
      await chmod(temporary, 0o600);
      const info = await stat(temporary);
      if (info.size > BACKUP_LIMIT)
        throw new AppError("BACKUP_LIMIT", "Backup exceeds 5 GiB");
      await rename(temporary, this.path(id));
      return { id, createdAt: manifest.createdAt, byteSize: info.size };
    } finally {
      await rm(stage, { recursive: true, force: true });
      await rm(temporary, { force: true });
    }
  }
  async upload(req: Request): Promise<BackupView> {
    await this.init();
    if (!req.body || Number(req.headers.get("content-length")) > BACKUP_LIMIT)
      throw new AppError("BACKUP_LIMIT", "Backup exceeds 5 GiB");
    const id = crypto.randomUUID() + ".tar.gz",
      path = this.path(id),
      temp = path + ".tmp";
    let received = 0;
    try {
      await Bun.write(
        temp,
        new Response(
          req.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > BACKUP_LIMIT)
                  throw new AppError("BACKUP_LIMIT", "Backup exceeds 5 GiB");
                controller.enqueue(chunk);
              },
            }),
          ),
        ),
      );
      await chmod(temp, 0o600);
      const stage = await this.unpack(temp);
      await rm(stage, { recursive: true, force: true });
      await rename(temp, path);
      return { id, createdAt: Date.now(), byteSize: received };
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async unpack(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.size > BACKUP_LIMIT) throw invalid();
    let total = 0,
      count = 0,
      bad = false;
    const seen = new Set<string>();
    // Validate all archive paths and entry types BEFORE extraction; never follow links.
    await list({
      file: path,
      strict: true,
      onReadEntry(entry) {
        const name = entry.path.replace(/\/$/, "");
        total += entry.size;
        if (
          ++count > 1_000_000 ||
          total > expandedLimit ||
          name.length > 4096 ||
          (name === "manifest.json" && entry.size > 1024 * 1024) ||
          !["File", "Directory"].includes(entry.type) ||
          name.split("/").some((p) => !p || p === "." || p === "..") ||
          /[\\\x00-\x1f]/.test(name) ||
          !(
            name === "manifest.json" ||
            name === "data" ||
            name.startsWith("data/")
          ) ||
          seen.has(name)
        )
          bad = true;
        seen.add(name);
      },
    }).catch(() => {
      throw invalid();
    });
    if (bad || !seen.has("manifest.json") || !seen.has("data/database.sqlite"))
      throw invalid();
    const stage = await mkdtemp(join(this.directory, ".restore-"));
    try {
      await extract({
        file: path,
        cwd: stage,
        strict: true,
        noChmod: true,
        noMtime: true,
        filter: (_path, entry) =>
          "type" in entry &&
          (entry.type === "File" || entry.type === "Directory"),
      });
      const m = JSON.parse(
        await readFile(join(stage, "manifest.json"), "utf8"),
      ) as Manifest;
      if (
        m.format !== 1 ||
        m.version !== packageJson.version ||
        !isAbsolute(m.root) ||
        !/^[a-f0-9]{64}$/i.test(m.encryptionKey) ||
        !Array.isArray(m.localSources) ||
        m.localSources.some(
          (s) =>
            !/^[a-f0-9-]{36}$/.test(s.id) ||
            s.directory !== "originals/" + s.id ||
            !validConfigPath(s.configPath),
        )
      )
        throw invalid();
      // Only this defined data layout may replace the live root.
      const allowed = new Set([
        "database.sqlite",
        "site-settings.json",
        "themes",
        "plugins",
        "temp",
        "uploads",
        "originals",
      ]);
      const entries = await readdir(join(stage, "data"));
      if (
        !entries.includes("site-settings.json") ||
        entries.some((name) => !allowed.has(name))
      )
        throw invalid();
      return stage;
    } catch (e) {
      await rm(stage, { recursive: true, force: true });
      throw e instanceof AppError ? e : invalid();
    }
  }
  // Caller has stopped the application and retains the work-directory lock.
  async restore(
    id: string,
    key: string,
  ): Promise<{ previous: string; rollback(): Promise<void> }> {
    const stage = await this.unpack(this.path(id));
    const data = join(stage, "data");
    const previous = this.root + ".before-restore-" + crypto.randomUUID();
    try {
      const manifest = JSON.parse(
        await readFile(join(stage, "manifest.json"), "utf8"),
      ) as Manifest;
      const roots: Record<string, { root: string; configPath: string }> = {};
      for (const source of manifest.localSources) {
        if (!(await stat(join(data, source.directory))).isDirectory())
          throw invalid();
        roots[source.id] = {
          root: join(this.root, source.directory),
          configPath: source.configPath,
        };
      }
      prepareRestoredDatabase(
        join(data, "database.sqlite"),
        roots,
        manifest.encryptionKey,
        key,
      );
      const plugins = join(data, "plugins");
      for (const entry of await readdir(plugins, { withFileTypes: true }).catch(
        () => [],
      ))
        if (entry.isDirectory() && !entry.name.startsWith("."))
          await rename(
            join(plugins, entry.name),
            join(plugins, "package-" + crypto.randomUUID()),
          );
      await copyTree(
        join(this.root, "service.lock"),
        join(data, "service.lock"),
      );
      await rename(this.root, previous);
      try {
        await rename(data, this.root);
      } catch (e) {
        await rename(previous, this.root);
        throw e;
      }
      return {
        previous,
        rollback: async () => {
          const failed = this.root + ".failed-restore-" + crypto.randomUUID();
          await rename(this.root, failed);
          await rename(previous, this.root);
          // Keep the failed restore for diagnosis; never remove the original data.
        },
      };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
