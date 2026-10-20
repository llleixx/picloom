import { Readable } from "node:stream";
import {
  PluginError,
  withAbortSignal,
  type Definition,
} from "../../plugin-sdk";

export default {
  defaultLocale: "en-US",
  content: { "en-US": { name: "Example thumbnail" } },

  id: "example.thumbnail",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    access: {
      defaultLocale: "en-US",
      content: { "en-US": {} },

      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      paramsSchema: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 1, maximum: 8192 },
        },
        additionalProperties: false,
      },
      async createInstance({ services }) {
        return {
          async check({ metadata, params }) {
            if (params.width === undefined) return { status: "noop" };
            return !metadata.animated &&
              ["image/jpeg", "image/png", "image/webp"].includes(
                metadata.mimeType ?? "",
              )
              ? { status: "applicable" }
              : {
                  status: "unsupported",
                  reason: "Only static JPEG, PNG and WebP images are supported",
                };
          },
          async process({ getFile, params, limits, createOutput }, { signal }) {
            const width = Number(params.width);
            if (width > limits.maxDimension)
              throw new PluginError(
                "RESOURCE_LIMIT",
                "Width exceeds processing limit",
              );
            signal.throwIfAborted();
            const file = await getFile();
            const bytes = await new Response(
              await file.openRead(),
            ).arrayBuffer();
            const output = await createOutput();
            // Sharp is supplied by the host; the package does not bundle its own copy.
            const image = services.images
              .sharp(bytes, { limitInputPixels: limits.maxPixels })
              .rotate()
              .resize({ width, withoutEnlargement: true })
              .toFormat(
                file.metadata.mimeType === "image/jpeg"
                  ? "jpeg"
                  : file.metadata.mimeType === "image/webp"
                    ? "webp"
                    : "png",
              );
            await withAbortSignal(image, signal, () =>
              output.write(
                Readable.toWeb(image) as unknown as ReadableStream<Uint8Array>,
              ),
            );
            signal.throwIfAborted();
            return { status: "replace", output };
          },
        };
      },
    },
  },
} satisfies Definition<"processor">;
