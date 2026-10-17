import { Readable } from "node:stream";
import { PluginError, type Definition } from "../../plugin-sdk";

export default {
  id: "example.resize",
  name: "Example resize",
  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          width: {
            type: "integer",
            title: "Maximum width",
            minimum: 1,
            default: 1280,
          },
        },
        required: ["width"],
        additionalProperties: false,
      },
      async createInstance({ config, services }) {
        const width = Number(config.width);
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
          async process({ file, limits, createOutput }, { signal }) {
            if (width > limits.maxDimension)
              throw new PluginError(
                "TOO_LARGE",
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
            await output.write(
              Readable.toWeb(image) as unknown as ReadableStream<Uint8Array>,
            );
            signal.throwIfAborted();
            return { status: "replace", output };
          },
        };
      },
    },
  },
} satisfies Definition<"processor">;
