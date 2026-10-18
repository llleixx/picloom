import type { PluginManager } from "../plugins/manager";
import { join } from "node:path";
import type { Persistence } from "../persistence/port";
import type { LocalUsage, SystemStatus } from "../../shared/api";
import { localUsage } from "../infra/disk-usage";
import { taskFailure } from "./errors";
export class SystemMonitor {
  private started = performance.now();
  private pending: Promise<void> | undefined;
  private usage: LocalUsage = {
    measuredAt: null,
    calculating: false,
    diskTotal: null,
    diskAvailable: null,
    originals: null,
    temporary: null,
    cache: null,
  };
  constructor(
    private db: Persistence,
    private root: string,
    private database: "sqlite" | "postgres",
    private plugins: PluginManager,
  ) {}
  async get(): Promise<SystemStatus> {
    const { summary, roots, rootsKnown } = await this.db.read(async (r) => {
      const summary = await r.systemSummary();
      const roots: string[] = [];
      let rootsKnown = true;
      for (const instance of await r.instances()) {
        try {
          const directory = this.plugins.localDirectory(instance);
          if (directory) roots.push(directory.root);
        } catch {
          // An unavailable plugin must not hide the rest of the system status.
          rootsKnown = false;
        }
      }
      return { summary, roots, rootsKnown };
    });
    if (
      !this.pending &&
      (this.usage.measuredAt === null ||
        Date.now() - this.usage.measuredAt >= 60_000)
    ) {
      this.usage.calculating = true;
      this.pending = localUsage(this.root, [
        join(this.root, "originals"),
        ...roots,
      ])
        .then((value) => {
          this.usage = {
            ...value,
            originals: rootsKnown ? value.originals : null,
            calculating: false,
          };
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return {
      ...summary,
      failures: summary.failures.map((f) => {
        let error: string | null = null;
        try {
          error = taskFailure(f.error).code;
        } catch {
          error = "TASK_FAILED";
        }
        return {
          ...f,
          error:
            error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error)
              ? error
              : "TASK_FAILED",
        };
      }),
      database: this.database,
      checkedAt: Date.now(),
      uptimeSeconds: Math.floor((performance.now() - this.started) / 1000),
      local: {
        ...this.usage,
        originals: rootsKnown ? this.usage.originals : null,
      },
    };
  }
  async invalidateUsage() {
    await this.pending;
    this.usage.measuredAt = null;
  }
  async close() {
    await this.pending;
  }
}
