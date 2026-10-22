import { test, expect, spyOn } from "bun:test";
import sharp from "sharp";
import { fixture } from "./helpers";
import { identify, thumbnail } from "../src/infra/images";
import { sharpProcessor } from "../src/builtins/processor/sharp/index";
import type { InstanceServices } from "@picloom/plugin-sdk";
import { pipelineData } from "../src/core/pipeline-data";
import { join } from "node:path";

test("internal image cancellation destroys Sharp and preserves the cancellation reason", async () => {
  const f = await fixture();
  const destroy = spyOn(sharp.prototype, "destroy");
  try {
    const path = join(f.root, "input.png");
    await Bun.write(path, f.png);
    for (const run of [
      (signal: AbortSignal) => identify(path, 1_000_000, signal),
      (signal: AbortSignal) => thumbnail(path, 1_000_000, 40, signal),
    ]) {
      destroy.mockClear();
      const controller = new AbortController();
      const reason = new Error("Cancelled by caller");
      const pending = run(controller.signal);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(destroy).toHaveBeenCalled();
    }
  } finally {
    destroy.mockRestore();
    await f.close();
  }
});

test("Sharp cancellation closes a blocked input without creating output", async () => {
  const runtime = await sharpProcessor.stages.upload!.createInstance({
    id: "cancel",
    config: {},
    services: { images: { sharp } } as InstanceServices,
  });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let cancelled = false;
  const controller = new AbortController();
  const reason = new Error("Stop blocked input");
  const processing = runtime.process(
    {
      params: { w: 10 },
      limits: { maxDimension: 100, maxPixels: 10000 },
      file: {
        metadata: {
          mimeType: "image/png",
          byteSize: null,
          width: 40,
          height: 20,
        },
        async openRead() {
          return new ReadableStream<Uint8Array>(
            {
              pull() {
                reading();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
        },
      },
      async createOutput() {
        throw new Error("Must not create output");
      },
    },
    {
      signal: controller.signal,
      requestId: "cancel",
      log() {},
      data: pipelineData(),
    },
  );
  await started;
  controller.abort(reason);
  await expect(processing).rejects.toThrow();
  expect(cancelled).toBe(true);
});
