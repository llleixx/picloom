# 水印

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.zh-CN.md)

## 用途

在上传或访问阶段添加文字或图片水印。

`builtin.watermark` · `processor` · `upload`, `access`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。

### `upload / access`

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `type` | 水印类型 | 是 | `"text"` | `text`, `image` |
| `text` | 水印文字 | 否 | — | 最多 500 字符 |
| `font` | 字体名称 | 文字模式 | `"sans"` | — |
| `fontFile` | 服务端字体文件路径 | 否 | — | — |
| `sizeMode` | 相对尺寸或固定像素 | 是 | `"relative"` | `relative`, `fixed` |
| `fontSizePercent` | 字号占原图短边百分比 | 文字且相对尺寸 | `3` | ≥ 0.1；≤ 50 |
| `marginPercent` | 边距占原图短边百分比 | 相对尺寸 | `2` | ≥ 0；≤ 49 |
| `fontSize` | 固定字号，像素 | 文字且固定尺寸 | `32` | ≥ 1；≤ 512 |
| `color` | 文字颜色，六位十六进制 | 文字模式 | `"#ffffff"` | — |
| `imagePath` | 服务端水印图片路径 | 图片模式 | — | 图片模式必填 |
| `imageWidth` | 固定图片水印宽度，像素 | 图片且固定尺寸 | `128` | ≥ 1；≤ 16384 |
| `widthPercent` | 水印图片占原图宽度百分比 | 图片且相对尺寸 | `10` | ≥ 1；≤ 100 |
| `position` | 水印位置 | 是 | `"bottom-right"` | `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `margin` | 固定边距，像素 | 固定尺寸 | `16` | ≥ 0；≤ 4096 |
| `opacity` | 不透明度，百分比 | 是 | `70` | ≥ 0；≤ 100 |

上传和访问阶段均支持以下请求参数。先在流水线步骤中开放需要的参数，再在上传请求的 `params` JSON 对象或图片链接查询参数中传入。传入值仅覆盖本次处理，未传入的字段沿用实例配置；类型和取值范围与对应配置字段相同。

| 请求参数 | 对应配置字段 |
| --- | --- |
| `watermarkText` | `text` |
| `watermarkColor` | `color` |
| `watermarkPosition` | `position` |
| `watermarkOpacity` | `opacity` |
| `watermarkSizeMode` | `sizeMode` |
| `watermarkFontSize` | `fontSize` |
| `watermarkFontSizePercent` | `fontSizePercent` |
| `watermarkImageWidth` | `imageWidth` |
| `watermarkWidthPercent` | `widthPercent` |
| `watermarkMargin` | `margin` |
| `watermarkMarginPercent` | `marginPercent` |

`type`、`font`、`fontFile`、`imagePath` 仅通过实例配置设置。切换尺寸模式时，合并后的配置必须具备该模式所需的字号或图片宽度及边距。没有独立水印开关；开放 `watermarkOpacity` 后，客户端可以传 `0` 跳过水印。

## 使用示例

创建上传阶段实例并加入上传流水线，上传一张 JPEG，确认右下角出现文字。若希望保留原图，另建访问阶段实例并加入全局访问流水线。中文文字需在服务端提供包含中文字形的字体，可通过 `fontFile` 指定。

```json
{
  "type": "text",
  "font": "sans",
  "sizeMode": "relative",
  "fontSizePercent": 3,
  "marginPercent": 2,
  "fontSize": 32,
  "color": "#ffffff",
  "imageWidth": 128,
  "widthPercent": 10,
  "position": "bottom-right",
  "margin": 16,
  "opacity": 70,
  "text": "Picloom"
}
```

开放 `watermarkText` 和 `watermarkOpacity` 后，上传请求可传 `params={"watermarkText":"Alice","watermarkOpacity":50}`；访问链接可追加 `?watermarkText=Alice&watermarkOpacity=50`。

## 行为与限制

只处理静态 JPEG、PNG、WebP，成功返回 `replace`。文字模式在合并请求参数后，文字缺省、为空或仅含空白时跳过；可将实例文字留空，并开放 `watermarkText`，通过 URL 参数按需添加水印。图片模式必须填写服务端 `imagePath`；图片水印同样限静态 PNG/JPEG/WebP。相对尺寸下，字号与边距以原图短边为基准，图片水印宽度以原图宽度为基准。有效配置的不透明度为 0 时跳过。

需要保存内容始终含水印时，使用上传阶段水印，配置非空文字和非零不透明度，不开放 `watermarkText` 或 `watermarkOpacity`。
