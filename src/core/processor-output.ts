import type { Output } from "../plugins/api";
import type { TemporarySpace } from "../infra/temporary-space";
import { output } from "../infra/files";
import { AppError } from "./errors";

/** Outputs belong to one processor invocation, including all pending writes. */
export function processorOutputs(
  temporary: TemporarySpace,
  owned: Set<string>,
  maxBytes: number,
  signal: AbortSignal,
) {
  let active = true;
  const created = new Map<string, { output: Output; path: string }>();
  const writes: Promise<void>[] = [];
  return {
    async createOutput(): Promise<Output> {
      signal.throwIfAborted();
      if (!active)
        throw new AppError("PLUGIN_OUTPUT", "Output scope has ended", 500);
      const path = temporary.create();
      owned.add(path);
      let written = false;
      const value = output(path, (stream) => {
        if (!active || written)
          throw new AppError("PLUGIN_OUTPUT", "Output is closed", 500);
        written = true;
        const pending = temporary
          .write(path, stream, maxBytes, signal)
          .then(() => {});
        writes.push(pending);
        void pending.catch(() => {});
        return pending;
      });
      created.set(value.handle, { output: value, path });
      return value;
    },
    async accept(value: Output) {
      const item = created.get(value?.handle);
      if (!item || item.output !== value)
        throw new AppError(
          "PLUGIN_OUTPUT",
          "Plugin returned an unowned output",
          500,
        );
      await Promise.all(writes);
      signal.throwIfAborted();
      return item.path;
    },
    async close() {
      active = false;
      await Promise.allSettled(writes);
    },
  };
}
