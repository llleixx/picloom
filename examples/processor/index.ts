import { Readable } from "node:stream";
import {
  PluginError,
  withAbortSignal,
  type Definition,
} from "../../plugin-sdk";

export default {
  defaultLocale: "en-US",
  content: { "en-US": { name: "Example resize" } },

  id: "example.resize",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: {
      defaultLocale: "en-US",
      content: {
        "en-US": {
          configSchema: { "/properties/width": { title: "Maximum width" } },
        },
      },

      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          width: {
            type: "integer",

            minimum: 1,
            default: 1280,
          },
        },
        required: ["width"],
        additionalProperties: false,
      },
      paramsSchema: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 1, maximum: 8192 },
        },
        additionalProperties: false,
      },
      async createInstance({ config, services }) {
        return {
          async check({ file }) {
            return !file.metadata.animated &&
              ["image/jpeg", "image/png", "image/webp"].includes(
                file.metadata.mimeType ?? "",
              )
              ? { status: "applicable" }
              : {
                  status: "unsupported",
                  reason: "Only static JPEG, PNG and WebP images are supported",
                };
          },
          async process({ file, params, limits, createOutput }, { signal }) {
            const width = Number(params.width ?? config.width);
            if (width > limits.maxDimension)
              throw new PluginError(
                "RESOURCE_LIMIT",
                "Width exceeds processing limit",
              );
            signal.throwIfAborted();
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
