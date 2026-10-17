import { Readable } from "node:stream";
import { retainStream, withAbortSignal } from "../../plugin-sdk/files";
import { readFile } from "node:fs/promises";
import {
  PluginError,
  type Config,
  type Definition,
  type Descriptor,
  type ProcessorPlugin,
  type CheckInput,
  type ProcessorInput,
  type AccessCheckInput,
  type AccessProcessorInput,
} from "../../plugin-sdk";
const configSchema: Config = {
  type: "object",
  properties: {
    type: {
      type: "string",
      title: "Watermark Type",
      enum: ["text", "image"],
      default: "text",
    },
    text: { type: "string", title: "Text", maxLength: 500 },
    font: { type: "string", title: "Font", default: "sans" },
    fontFile: {
      type: "string",
      title: "Font File",
      description:
        "Optional server font file. Chinese text requires a font with Chinese glyphs.",
    },
    sizeMode: {
      type: "string",
      title: "Size Mode",
      enum: ["relative", "fixed"],
      default: "relative",
      description: "Relative uses percentages; Fixed uses pixels.",
    },
    fontSizePercent: {
      type: "number",
      title: "Font Size (% of Short Side)",
      minimum: 0.1,
      maximum: 50,
      default: 3,
    },
    marginPercent: {
      type: "number",
      title: "Margin (% of Short Side)",
      minimum: 0,
      maximum: 49,
      default: 2,
    },
    fontSize: {
      type: "integer",
      title: "Font Size (px)",
      minimum: 1,
      maximum: 512,
      default: 32,
    },
    color: {
      type: "string",
      title: "Color",
      pattern: "^#[0-9a-fA-F]{6}$",
      default: "#ffffff",
    },
    imagePath: {
      type: "string",
      title: "Image Path",
      description: "Server path to a static PNG, JPEG or WebP watermark.",
    },
    imageWidth: {
      type: "integer",
      title: "Image Width (px)",
      minimum: 1,
      maximum: 16384,
      default: 128,
    },
    widthPercent: {
      type: "number",
      title: "Image Width (%)",
      minimum: 1,
      maximum: 100,
      default: 10,
    },
    position: {
      type: "string",
      title: "Position",
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
      type: "integer",
      title: "Margin (px)",
      minimum: 0,
      maximum: 4096,
      default: 16,
    },
    opacity: {
      type: "number",
      title: "Opacity (%)",
      minimum: 0,
      maximum: 100,
      default: 70,
    },
  },
  required: ["type"],
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
    translations: {
      "zh-CN": {
        configSchema: {
          "/properties/type": {
            title: "水印类型",
            enumLabels: ["文字", "图片"],
          },
          "/properties/text": {
            title: "文字",
          },
          "/properties/font": {
            title: "字体",
          },
          "/properties/fontFile": {
            title: "字体文件",
            description:
              "可选的服务器字体文件。中文文字需要支持中文字形的字体。",
          },
          "/properties/sizeMode": {
            title: "尺寸模式",
            enumLabels: ["相对尺寸", "固定尺寸"],
            description: "相对尺寸使用百分比，固定尺寸使用像素。",
          },
          "/properties/fontSizePercent": {
            title: "字号（短边百分比）",
          },
          "/properties/marginPercent": {
            title: "边距（短边百分比）",
          },
          "/properties/fontSize": {
            title: "字号（px）",
          },
          "/properties/color": {
            title: "颜色",
          },
          "/properties/imagePath": {
            title: "图片路径",
            description: "服务器上的静态 PNG、JPEG 或 WebP 水印图片路径。",
          },
          "/properties/imageWidth": {
            title: "图片宽度（px）",
          },
          "/properties/widthPercent": {
            title: "图片宽度（%）",
          },
          "/properties/position": {
            title: "位置",
            enumLabels: [
              "左上",
              "上方",
              "右上",
              "左侧",
              "居中",
              "右侧",
              "左下",
              "下方",
              "右下",
            ],
          },
          "/properties/margin": {
            title: "边距（px）",
          },
          "/properties/opacity": {
            title: "不透明度（%）",
          },
        },
      },
    },
    configSchemaVersion: 1,
    configSchema,
    uiHints: Object.fromEntries([
      ["/type", { order: -2 }],
      ["/sizeMode", { order: -1 }],
      ["/fontSize", { visibleWhen: { path: "/sizeMode", equals: "fixed" } }],
      [
        "/fontSizePercent",
        { visibleWhen: { path: "/sizeMode", equals: "relative" } },
      ],
      ["/margin", { visibleWhen: { path: "/sizeMode", equals: "fixed" } }],
      [
        "/marginPercent",
        { visibleWhen: { path: "/sizeMode", equals: "relative" } },
      ],
      ...["text", "font", "fontFile", "color"].map((key) => [
        "/" + key,
        { visibleWhen: { path: "/type", equals: "text" } },
      ]),
      ["/imageWidth", { visibleWhen: { path: "/sizeMode", equals: "fixed" } }],
      [
        "/widthPercent",
        { visibleWhen: { path: "/sizeMode", equals: "relative" } },
      ],
      ...["imagePath"].map((key) => [
        "/" + key,
        { visibleWhen: { path: "/type", equals: "image" } },
      ]),
    ]),
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
                  ? (shortSide * Number(config.fontSizePercent ?? 3)) / 100
                  : Number(config.fontSize ?? 32),
              ),
            );
            const margin = Math.min(
              Math.round(
                relative
                  ? (shortSide * Number(config.marginPercent ?? 2)) / 100
                  : Number(config.margin ?? 16),
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
                          ? (width * Number(config.widthPercent ?? 10)) / 100
                          : Number(config.imageWidth ?? 128),
                      ),
                    ),
                  ),
                  height: availableHeight,
                  fit: "inside",
                });
            } else {
              if (String(config.text).length * fontSize ** 2 > limits.maxPixels)
                throw new PluginError(
                  "INVALID_PARAMS",
                  "Watermark text exceeds the pixel limit",
                  false,
                  "notApplied",
                );
              overlay = sharp({
                text: {
                  text: `<span foreground="${config.color ?? "#ffffff"}">${escape(String(config.text))}</span>`,
                  font: `${config.font ?? "sans"} ${fontSize}`,
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
                (mark.data[i]! * Number(config.opacity ?? 70)) / 100,
              );
            const position = String(config.position ?? "bottom-right");
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
export const watermark: Definition<"processor"> = {
  id: "builtin.watermark",
  name: "Watermark",
  translations: { "zh-CN": { name: "水印" } },
  description: "Add a text or image watermark.",
  kind: "processor",
  version: "1.0.0",
  apiVersion: 1,
  stages: {
    upload: stage(false),
    access: {
      ...stage(true),
      paramsSchema: {
        type: "object",
        properties: { watermark: { type: "boolean", title: "Watermark" } },
        additionalProperties: false,
      },
    },
  },
};
