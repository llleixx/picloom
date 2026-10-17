import {
  PluginError,
  type Definition,
  type Config,
  type Parameters,
  type ProcessorPlugin,
  type CheckInput,
  type ProcessorInput,
  type AccessCheckInput,
  type AccessProcessorInput,
} from "../../plugin-sdk";
const transformProperties: Config = {
  w: { type: "integer", title: "Width", minimum: 1 },
  h: { type: "integer", title: "Height", minimum: 1 },
  fit: {
    type: "string",
    title: "Fit",
    enum: ["inside", "cover", "contain", "fill"],
  },
  q: { type: "integer", title: "Quality", minimum: 1, maximum: 100 },
  format: {
    type: "string",
    title: "Output format",
    enum: ["jpeg", "png", "webp"],
  },
};
const settings: Config = {
  allowEnlargement: {
    type: "boolean",
    title: "Allow enlargement",
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
          "INVALID_PARAMS",
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
      const { limits, createOutput } = input;
      const file = "getFile" in input ? await input.getFile() : input.file;
      const { params } = input;
      ctx.signal.throwIfAborted();
      const p = parameters(params);
      const bytes = await new Response(await file.openRead()).arrayBuffer();
      let image = sharp(Buffer.from(bytes), {
        limitInputPixels: limits.maxPixels,
      }).autoOrient();
      if (p.w || p.h)
        image = image.resize({
          width: p.w as number | undefined,
          height: p.h as number | undefined,
          fit: (p.fit ?? "inside") as "inside" | "cover" | "contain" | "fill",
          withoutEnlargement: !config.allowEnlargement,
        });
      const format = p.format ?? file.metadata.mimeType!.slice(6);
      if (format === "png")
        image = image.png(p.q ? { quality: p.q as number, palette: true } : {});
      else if (format === "jpeg")
        image = image.jpeg({ quality: (p.q ?? 80) as number });
      else image = image.webp({ quality: (p.q ?? 80) as number });
      const out = await createOutput();
      await image.toFile(out.path);
      ctx.signal.throwIfAborted();
      return { status: "replace", output: out };
    },
  };
}
export const sharpProcessor: Definition<"processor"> = {
  id: "builtin.sharp",
  name: "Sharp transform",
  translations: {
    "zh-CN": {
      name: "Sharp 图片处理",
    },
  },
  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: {
      translations: {
        "zh-CN": {
          configSchema: {
            "/properties/w": {
              title: "宽度",
            },
            "/properties/h": {
              title: "高度",
            },
            "/properties/fit": {
              title: "适配方式",
              enumLabels: [
                "限制在框内",
                "覆盖（裁剪）",
                "完整包含",
                "填充（拉伸）",
              ],
            },
            "/properties/q": {
              title: "质量",
            },
            "/properties/format": {
              title: "输出格式",
            },
            "/properties/allowEnlargement": {
              title: "允许放大",
            },
          },
          paramsSchema: {
            "/properties/w": {
              title: "宽度",
            },
            "/properties/h": {
              title: "高度",
            },
            "/properties/fit": {
              title: "适配方式",
              enumLabels: [
                "限制在框内",
                "覆盖（裁剪）",
                "完整包含",
                "填充（拉伸）",
              ],
            },
            "/properties/q": {
              title: "质量",
            },
            "/properties/format": {
              title: "输出格式",
            },
          },
        },
      },
      paramsSchema: {
        type: "object",
        properties: transformProperties,
        additionalProperties: false,
      },
      configSchemaVersion: 1,
      configSchema: {
        type: "object",
        properties: { ...transformProperties, ...settings },
        additionalProperties: false,
      },
      uiHints: {
        "/allowEnlargement": { advanced: true },
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
      translations: {
        "zh-CN": {
          configSchema: {
            "/properties/allowEnlargement": {
              title: "允许放大",
            },
          },
          paramsSchema: {
            "/properties/w": {
              title: "宽度",
            },
            "/properties/h": {
              title: "高度",
            },
            "/properties/fit": {
              title: "适配方式",
              enumLabels: [
                "限制在框内",
                "覆盖（裁剪）",
                "完整包含",
                "填充（拉伸）",
              ],
            },
            "/properties/q": {
              title: "质量",
            },
            "/properties/format": {
              title: "输出格式",
            },
          },
        },
      },
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
