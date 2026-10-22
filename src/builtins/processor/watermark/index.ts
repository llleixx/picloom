import { Readable } from "node:stream";
import { retainStream, withAbortSignal } from "@picloom/plugin-sdk";
import { readFile } from "node:fs/promises";
import {
  PluginError,
  type ConfigSchema,
  type Definition,
  type Descriptor,
  type ProcessorPlugin,
  type CheckInput,
  type ProcessorInput,
  type AccessCheckInput,
  type AccessProcessorInput,
} from "@picloom/plugin-sdk";
const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    type: {
      "x-ui": {
        labelKey: "settings.type.label",
        enumKeys: ["settings.type.options.text", "settings.type.options.image"],
        order: -2,
      },
      type: "string",

      enum: ["text", "image"],
      default: "text",
    },
    text: {
      "x-ui": {
        labelKey: "settings.text.label",
        visibleWhen: { path: "/type", equals: "text" },
      },
      type: "string",
      maxLength: 500,
    },
    font: {
      "x-ui": {
        labelKey: "settings.font.label",
        visibleWhen: { path: "/type", equals: "text" },
      },
      type: "string",
      default: "sans",
    },
    fontFile: {
      "x-ui": {
        labelKey: "settings.fontFile.label",
        descriptionKey: "settings.fontFile.description",
        visibleWhen: { path: "/type", equals: "text" },
      },
      type: "string",
    },
    sizeMode: {
      "x-ui": {
        labelKey: "settings.sizeMode.label",
        descriptionKey: "settings.sizeMode.description",
        enumKeys: [
          "settings.sizeMode.options.relative",
          "settings.sizeMode.options.fixed",
        ],
        order: -1,
      },
      type: "string",

      enum: ["relative", "fixed"],
      default: "relative",
    },
    fontSizePercent: {
      "x-ui": {
        labelKey: "settings.fontSizePercent.label",
        visibleWhen: { path: "/sizeMode", equals: "relative" },
      },
      type: "number",

      minimum: 0.1,
      maximum: 50,
      default: 3,
    },
    marginPercent: {
      "x-ui": {
        labelKey: "settings.marginPercent.label",
        visibleWhen: { path: "/sizeMode", equals: "relative" },
      },
      type: "number",

      minimum: 0,
      maximum: 49,
      default: 2,
    },
    fontSize: {
      "x-ui": {
        labelKey: "settings.fontSize.label",
        visibleWhen: { path: "/sizeMode", equals: "fixed" },
      },
      type: "integer",

      minimum: 1,
      maximum: 512,
      default: 32,
    },
    color: {
      "x-ui": {
        labelKey: "settings.color.label",
        visibleWhen: { path: "/type", equals: "text" },
      },
      type: "string",

      pattern: "^#[0-9a-fA-F]{6}$",
      default: "#ffffff",
    },
    imagePath: {
      "x-ui": {
        labelKey: "settings.imagePath.label",
        descriptionKey: "settings.imagePath.description",
        visibleWhen: { path: "/type", equals: "image" },
      },
      type: "string",
    },
    imageWidth: {
      "x-ui": {
        labelKey: "settings.imageWidth.label",
        visibleWhen: { path: "/sizeMode", equals: "fixed" },
      },
      type: "integer",

      minimum: 1,
      maximum: 16384,
      default: 128,
    },
    widthPercent: {
      "x-ui": {
        labelKey: "settings.widthPercent.label",
        visibleWhen: { path: "/sizeMode", equals: "relative" },
      },
      type: "number",

      minimum: 1,
      maximum: 100,
      default: 10,
    },
    position: {
      "x-ui": {
        labelKey: "settings.position.label",
        enumKeys: [
          "settings.position.options.top-left",
          "settings.position.options.top",
          "settings.position.options.top-right",
          "settings.position.options.left",
          "settings.position.options.center",
          "settings.position.options.right",
          "settings.position.options.bottom-left",
          "settings.position.options.bottom",
          "settings.position.options.bottom-right",
        ],
      },
      type: "string",

      enum: [
        "top-left",
        "top",
        "top-right",
        "left",
        "center",
        "right",
        "bottom-left",
        "bottom",
        "bottom-right",
      ],
      default: "bottom-right",
    },
    margin: {
      "x-ui": {
        labelKey: "settings.margin.label",
        visibleWhen: { path: "/sizeMode", equals: "fixed" },
      },
      type: "integer",

      minimum: 0,
      maximum: 4096,
      default: 16,
    },
    opacity: {
      "x-ui": { labelKey: "settings.opacity.label" },
      type: "number",

      minimum: 0,
      maximum: 100,
      default: 70,
    },
  },
  required: ["type", "sizeMode", "opacity", "position"],
  allOf: [
    {
      if: { properties: { type: { const: "text" } }, required: ["type"] },
      then: { required: ["text", "font", "color"] },
      else: { required: ["imagePath"] },
    },
    {
      if: {
        properties: { sizeMode: { const: "relative" } },
        required: ["sizeMode"],
      },
      then: { required: ["marginPercent"] },
      else: { required: ["margin"] },
    },
    {
      if: {
        properties: {
          type: { const: "text" },
          sizeMode: { const: "relative" },
        },
        required: ["type", "sizeMode"],
      },
      then: { required: ["fontSizePercent"] },
    },
    {
      if: {
        properties: { type: { const: "text" }, sizeMode: { const: "fixed" } },
        required: ["type", "sizeMode"],
      },
      then: { required: ["fontSize"] },
    },
    {
      if: {
        properties: {
          type: { const: "image" },
          sizeMode: { const: "relative" },
        },
        required: ["type", "sizeMode"],
      },
      then: { required: ["widthPercent"] },
    },
    {
      if: {
        properties: { type: { const: "image" }, sizeMode: { const: "fixed" } },
        required: ["type", "sizeMode"],
      },
      then: { required: ["imageWidth"] },
    },
  ],
  additionalProperties: false,
};
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
function stage(
  access: boolean,
): Descriptor<
  ProcessorPlugin<
    CheckInput | AccessCheckInput,
    ProcessorInput | AccessProcessorInput
  >
> {
  return {
    configSchemaVersion: 1,
    configSchema,
    async validateConfig(config) {
      const key = config.type === "image" ? "imagePath" : "text";
      return typeof config[key] !== "string" || !String(config[key]).trim()
        ? [{ path: "/" + key, message: "Required" }]
        : [];
    },
    async createInstance({ config, services }) {
      const sharp = services.images.sharp;
      if (config.type === "text" && config.fontFile)
        await readFile(String(config.fontFile));
      const asset =
        config.type === "image"
          ? await readFile(String(config.imagePath))
          : undefined;
      if (asset) {
        const metadata = await sharp(asset, {
          limitInputPixels: 16_000_000,
        }).metadata();
        if (
          !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
          (metadata.pages ?? 1) > 1
        )
          throw new Error("Watermark must be a static PNG, JPEG or WebP");
      }
      return {
        async check(input) {
          const { params } = input;
          if ((access && params.watermark === false) || config.opacity === 0)
            return { status: "noop" };
          const file = "getFile" in input ? await input.getFile() : input.file;
          if (
            file.metadata.animated ||
            !["image/jpeg", "image/png", "image/webp"].includes(
              file.metadata.mimeType ?? "",
            )
          )
            return {
              status: "unsupported",
              reason: "Watermarks support static JPEG, PNG and WebP",
            };
          return { status: "applicable" };
        },
        async process(input, context) {
          context.signal.throwIfAborted();
          const { limits, createOutput } = input;
          const file = "getFile" in input ? await input.getFile() : input.file;
          context.signal.throwIfAborted();
          const bytes = await new Response(
            retainStream(await file.openRead(), () => {}, context.signal),
          ).arrayBuffer();
          const base = sharp(Buffer.from(bytes), {
            limitInputPixels: limits.maxPixels,
          });
          return withAbortSignal(base, context.signal, async () => {
            const metadata = await base.metadata();
            const swap =
              metadata.orientation !== undefined &&
              metadata.orientation >= 5 &&
              metadata.orientation <= 8;
            const width = (swap ? metadata.height : metadata.width)!;
            const height = (swap ? metadata.width : metadata.height)!;
            const shortSide = Math.min(width, height);
            const relative = config.sizeMode === "relative";
            const fontSize = Math.max(
              1,
              Math.round(
                relative
                  ? (shortSide * Number(config.fontSizePercent)) / 100
                  : Number(config.fontSize),
              ),
            );
            const margin = Math.min(
              Math.round(
                relative
                  ? (shortSide * Number(config.marginPercent)) / 100
                  : Number(config.margin),
              ),
              Math.floor((Math.min(width, height) - 1) / 2),
            );
            const availableWidth = Math.max(1, width - 2 * margin),
              availableHeight = Math.max(1, height - 2 * margin);
            let overlay;
            if (asset) {
              overlay = sharp(asset, { limitInputPixels: limits.maxPixels })
                .autoOrient()
                .resize({
                  width: Math.min(
                    availableWidth,
                    Math.max(
                      1,
                      Math.round(
                        relative
                          ? (width * Number(config.widthPercent)) / 100
                          : Number(config.imageWidth),
                      ),
                    ),
                  ),
                  height: availableHeight,
                  fit: "inside",
                });
            } else {
              if (String(config.text).length * fontSize ** 2 > limits.maxPixels)
                throw new PluginError(
                  "INVALID_INPUT",
                  "Watermark text exceeds the pixel limit",
                  false,
                  "notApplied",
                );
              overlay = sharp({
                text: {
                  text: `<span foreground="${config.color}">${escape(String(config.text))}</span>`,
                  font: `${config.font} ${fontSize}`,
                  fontfile: config.fontFile
                    ? String(config.fontFile)
                    : undefined,
                  rgba: true,
                  dpi: 72,
                },
              }).resize({
                width: availableWidth,
                height: availableHeight,
                fit: "inside",
                withoutEnlargement: true,
              });
            }
            overlay.toColourspace("srgb").ensureAlpha().raw();
            const mark = await withAbortSignal(overlay, context.signal, () =>
              overlay.toBuffer({ resolveWithObject: true }),
            );
            for (let i = 3; i < mark.data.length; i += 4)
              mark.data[i] = Math.round(
                (mark.data[i]! * Number(config.opacity)) / 100,
              );
            const position = String(config.position);
            const left = position.includes("left")
              ? margin
              : position.includes("right")
                ? width - margin - mark.info.width
                : Math.floor((width - mark.info.width) / 2);
            const top = position.includes("top")
              ? margin
              : position.includes("bottom")
                ? height - margin - mark.info.height
                : Math.floor((height - mark.info.height) / 2);
            const image = base
              .autoOrient()
              .composite([{ input: mark.data, raw: mark.info, left, top }]);
            const output = await createOutput();
            const format = file.metadata.mimeType;
            if (format === "image/jpeg") image.jpeg({ quality: 90 });
            else if (format === "image/webp") image.webp({ quality: 90 });
            else image.png();
            context.signal.throwIfAborted();
            await output.write(
              Readable.toWeb(image) as unknown as ReadableStream<Uint8Array>,
            );
            context.signal.throwIfAborted();
            return { status: "replace" as const, output };
          });
        },
      };
    },
  };
}
const fieldMessages = {
  "en-US": {
    ...{ "params.watermark.label": "Watermark" },
    "settings.type.label": "Watermark Type",
    "settings.type.options.text": "text",
    "settings.type.options.image": "image",
    "settings.text.label": "Text",
    "settings.font.label": "Font",
    "settings.fontFile.label": "Font File",
    "settings.fontFile.description":
      "Optional server font file. Chinese text requires a font with Chinese glyphs.",
    "settings.sizeMode.label": "Size Mode",
    "settings.sizeMode.description":
      "Relative uses percentages; Fixed uses pixels.",
    "settings.sizeMode.options.relative": "relative",
    "settings.sizeMode.options.fixed": "fixed",
    "settings.fontSizePercent.label": "Font Size (% of Short Side)",
    "settings.marginPercent.label": "Margin (% of Short Side)",
    "settings.fontSize.label": "Font Size (px)",
    "settings.color.label": "Color",
    "settings.imagePath.label": "Image Path",
    "settings.imagePath.description":
      "Server path to a static PNG, JPEG or WebP watermark.",
    "settings.imageWidth.label": "Image Width (px)",
    "settings.widthPercent.label": "Image Width (%)",
    "settings.position.label": "Position",
    "settings.position.options.top-left": "top-left",
    "settings.position.options.top": "top",
    "settings.position.options.top-right": "top-right",
    "settings.position.options.left": "left",
    "settings.position.options.center": "center",
    "settings.position.options.right": "right",
    "settings.position.options.bottom-left": "bottom-left",
    "settings.position.options.bottom": "bottom",
    "settings.position.options.bottom-right": "bottom-right",
    "settings.margin.label": "Margin (px)",
    "settings.opacity.label": "Opacity (%)",
  },
  "zh-CN": {
    ...{ "params.watermark.label": "水印" },
    "settings.type.label": "水印类型",
    "settings.type.options.text": "文字",
    "settings.type.options.image": "图片",
    "settings.text.label": "文字",
    "settings.font.label": "字体",
    "settings.fontFile.label": "字体文件",
    "settings.fontFile.description":
      "可选的服务器字体文件。中文文字需要支持中文字形的字体。",
    "settings.sizeMode.label": "尺寸模式",
    "settings.sizeMode.description": "相对尺寸使用百分比，固定尺寸使用像素。",
    "settings.sizeMode.options.relative": "相对尺寸",
    "settings.sizeMode.options.fixed": "固定尺寸",
    "settings.fontSizePercent.label": "字号（短边百分比）",
    "settings.marginPercent.label": "边距（短边百分比）",
    "settings.fontSize.label": "字号（px）",
    "settings.color.label": "颜色",
    "settings.imagePath.label": "图片路径",
    "settings.imagePath.description":
      "服务器上的静态 PNG、JPEG 或 WebP 水印图片路径。",
    "settings.imageWidth.label": "图片宽度（px）",
    "settings.widthPercent.label": "图片宽度（%）",
    "settings.position.label": "位置",
    "settings.position.options.top-left": "左上",
    "settings.position.options.top": "上方",
    "settings.position.options.top-right": "右上",
    "settings.position.options.left": "左侧",
    "settings.position.options.center": "居中",
    "settings.position.options.right": "右侧",
    "settings.position.options.bottom-left": "左下",
    "settings.position.options.bottom": "下方",
    "settings.position.options.bottom-right": "右下",
    "settings.margin.label": "边距（px）",
    "settings.opacity.label": "不透明度（%）",
  },
};
export const watermark: Definition<"processor"> = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  descriptionKey: "package.description",
  messages: {
    "en-US": {
      ...fieldMessages["en-US"],
      "package.name": "Watermark",
      "package.description": "Add a text or image watermark.",
    },
    "zh-CN": {
      ...fieldMessages["zh-CN"],
      "package.name": "水印",
      "package.description": "为图片添加文字或图片水印。",
    },
  },

  id: "builtin.watermark",

  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: stage(false),
    access: {
      ...stage(true),
      paramsSchema: {
        type: "object",
        properties: {
          watermark: {
            type: "boolean",
            "x-ui": { labelKey: "params.watermark.label" },
          },
        },
        additionalProperties: false,
      },
    },
  },
};
