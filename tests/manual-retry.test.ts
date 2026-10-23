import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { PluginError } from "@picloom/plugin-sdk";

test("manual retry persists across restart, counts attempts cumulatively and never schedules an automatic retry", async () => {
  let retryable = false;
  const f = await fixture({
    beforeDelete: async () => {
      throw new PluginError(
        retryable ? "NETWORK" : "ACCESS_DENIED",
        "Failed",
        retryable,
        "notApplied",
      );
    },
  });
  try {
    const image = await (await f.upload()).json();
    await f.app.files.delete(image.id);
    await f.app.files.sweep();
    let task = (await f.app.db.read((r) => r.tasks(image.id))).find(
      (t) => t.kind === "delete",
    )!;
    expect(task.attempts).toBe(1);
    retryable = true;
    await f.app.files.tasks.retry(task.id);
    await f.restart();
    task = (await f.app.db.read((r) => r.task(task.id)))!;
    expect(task.manual_retry).toBe(true);
    expect(task.attempts).toBe(2);
    expect(task.status).toBe("failed");
    expect(task.next_run_at).toBeNull();
    await f.app.files.tasks.retry(task.id);
    await f.app.files.sweep();
    task = (await f.app.db.read((r) => r.task(task.id)))!;
    expect(task.attempts).toBe(3);
    expect(task.status).toBe("failed");
    // A crash while a manual attempt is running must not silently replay it.
    await f.app.files.tasks.retry(task.id);
    await f.app.db.transaction(async (r) => {
      const running = (await r.task(task.id))!;
      running.status = "running";
      running.attempts++;
      await r.saveTask(running);
    });
    await f.restart();
    task = (await f.app.db.read((r) => r.task(task.id)))!;
    expect(task.attempts).toBe(4);
    expect(task.status).toBe("failed");
    expect(task.last_error).toBe("INTERRUPTED_TASK");
  } finally {
    await f.close();
  }
});
