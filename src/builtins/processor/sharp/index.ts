import { Readable } from "node:stream";
import { retainStream, withAbortSignal } from "../../../../plugin-sdk/files";
import {
  PluginError,
  type Definition,
  type Config,
  type FieldSchema,
  type ParameterSchema,
  type Parameters,
  type ProcessorPlugin,
  type CheckInput,
  type ProcessorInput,
  type AccessCheckInput,
  type AccessProcessorInput,
} from "../../../../plugin-sdk";
const transformProperties: Record<string, ParameterSchema> = {
  w: { "x-ui": { labelKey: "params.w.label" }, type: "integer", minimum: 1 },
  h: { "x-ui": { labelKey: "params.h.label" }, type: "integer", minimum: 1 },
  fit: {
    "x-ui": {
      labelKey: "params.fit.label",
      enumKeys: [
        "params.fit.options.inside",
        "params.fit.options.cover",
        "params.fit.options.contain",
        "params.fit.options.fill",
      ],
    },
    type: "string",

    enum: ["inside", "cover", "contain", "fill"],
  },
  q: {
    "x-ui": { labelKey: "params.q.label" },
    type: "integer",
    minimum: 1,
    maximum: 100,
  },
  format: {
    "x-ui": { labelKey: "params.format.label" },
    type: "string",

    enum: ["jpeg", "png", "webp"],
  },
};
const settings: Record<string, FieldSchema> = {
  allowEnlargement: {
    "x-ui": { labelKey: "settings.allowEnlargement.label" },
    type: "boolean",

    default: false,
  },
};
function runtime(
  config: Readonly<Config>,
  fixed: boolean,
  sharp: typeof import("sharp"),
): ProcessorPlugin<
  CheckInput | AccessCheckInput,
  ProcessorInput | AccessProcessorInput
> {
  const parameters = (params: Parameters) =>
    fixed
      ? ({
          ...Object.fromEntries(
            Object.keys(transformProperties)
              .filter((k) => config[k] !== undefined)
              .map((k) => [k, config[k]]),
          ),
          ...params,
        } as Parameters)
      : params;
  return {
    async check(input) {
      const { limits } = input;
      const { params } = input;
      const p = parameters(params);
      if (!Object.keys(p).length) return { status: "noop" };
      const w = p.w as number | undefined,
        h = p.h as number | undefined;
      if (
        (w && w > limits.maxDimension) ||
        (h && h > limits.maxDimension) ||
        (w && h && w * h > limits.maxPixels) ||
        (p.fit && !w && !h)
      )
        throw new PluginError(
          "INVALID_INPUT",
          "Invalid image dimensions",
          false,
          "notApplied",
        );
      const file = "getFile" in input ? await input.getFile() : input.file;
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(
          file.metadata.mimeType ?? "",
        ) ||
        file.metadata.animated
      )
        return {
          status: "unsupported",
          reason: "Only static JPEG, PNG and WebP are supported",
        };
      if (file.metadata.alpha && p.format === "jpeg")
        return {
          status: "unsupported",
          reason: "JPEG cannot preserve transparency",
        };
      return { status: "applicable" };
    },
    async process(input, ctx) {
      ctx.signal.throwIfAborted();
      const { limits, createOutput } = input;
      const file = "getFile" in input ? await input.getFile() : input.file;
      const { params } = input;
      ctx.signal.throwIfAborted();
      const p = parameters(params);
      const bytes = await new Response(
        retainStream(await file.openRead(), () => {}, ctx.signal),
      ).arrayBuffer();
      let image = sharp(Buffer.from(bytes), {
        limitInputPixels: limits.maxPixels,
      }).autoOrient();
      return withAbortSignal(image, ctx.signal, async () => {
        if (p.w || p.h)
          image = image.resize({
            width: p.w as number | undefined,
            height: p.h as number | undefined,
            fit: (p.fit ?? "inside") as "inside" | "cover" | "contain" | "fill",
            withoutEnlargement: !config.allowEnlargement,
          });
        const format = p.format ?? file.metadata.mimeType!.slice(6);
        if (format === "png")
          image = image.png(
            p.q ? { quality: p.q as number, palette: true } : {},
          );
        else if (format === "jpeg")
          image = image.jpeg({ quality: (p.q ?? 80) as number });
        else image = image.webp({ quality: (p.q ?? 80) as number });
        const out = await createOutput();
        await out.write(
          Readable.toWeb(image) as unknown as ReadableStream<Uint8Array>,
        );
        ctx.signal.throwIfAborted();
        return { status: "replace" as const, output: out };
      });
    },
  };
}
export const sharpProcessor: Definition<"processor"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      "package.name": "Image Processing",
      "package.description": "Resize images and adjust format and quality.",
      "params.w.label": "Width",
      "params.h.label": "Height",
      "params.fit.label": "Fit",
      "params.q.label": "Quality",
      "params.format.label": "Output format",
      "settings.allowEnlargement.label": "Allow enlargement",
      "params.fit.options.inside": "inside",
      "params.fit.options.cover": "cover",
      "params.fit.options.contain": "contain",
      "params.fit.options.fill": "fill",
    },
    "zh-CN": {
      "package.name": "图片处理",
      "package.description": "调整图片尺寸、格式和质量。",
      "params.w.label": "宽度",
      "params.h.label": "高度",
      "params.fit.label": "适配方式",
      "params.q.label": "质量",
      "params.format.label": "输出格式",
      "settings.allowEnlargement.label": "允许放大",
      "params.fit.options.inside": "限制在框内",
      "params.fit.options.cover": "覆盖（裁剪）",
      "params.fit.options.contain": "完整包含",
      "params.fit.options.fill": "填充（拉伸）",
    },
  },

  id: "builtin.sharp",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: {
      paramsSchema: {
        type: "object",
        properties: transformProperties,
        additionalProperties: false,
      },
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: {
          ...transformProperties,
          allowEnlargement: {
            ...settings.allowEnlargement!,
            "x-ui": {
              labelKey: "settings.allowEnlargement.label",
              advanced: true,
            },
          },
        },
        additionalProperties: false,
      },
      async validateConfig(config) {
        return config.fit && !config.w && !config.h
          ? [{ path: "/fit", message: "Fit needs dimensions" }]
          : [];
      },
      async createInstance({ config, services }) {
        return runtime(config, true, services.images.sharp);
      },
    },
    access: {
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: settings,
        additionalProperties: false,
      },
      paramsSchema: {
        type: "object",
        properties: transformProperties,
        additionalProperties: false,
      },
      async createInstance({ config, services }) {
        return runtime(config, false, services.images.sharp);
      },
    },
  },
};
