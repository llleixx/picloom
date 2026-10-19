# Watermark

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.zh-CN.md)

## Purpose

Add text or image watermarks during upload or access.

`builtin.watermark` · `processor` · `upload`, `access`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available.

### `upload / access`

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `type` | Watermark Type | No | `"text"` | `text`, `image` |
| `text` | Text | Text mode | — | Up to 500 characters; Required in text mode |
| `font` | Font | No | `"sans"` | — |
| `fontFile` | Font File | No | — | — |
| `sizeMode` | Size Mode | No | `"relative"` | `relative`, `fixed` |
| `fontSizePercent` | Font Size (% of Short Side) | No | `3` | ≥ 0.1; ≤ 50 |
| `marginPercent` | Margin (% of Short Side) | No | `2` | ≥ 0; ≤ 49 |
| `fontSize` | Font Size (px) | No | `32` | ≥ 1; ≤ 512 |
| `color` | Color | No | `"#ffffff"` | — |
| `imagePath` | Image Path | Image mode | — | Required in image mode |
| `imageWidth` | Image Width (px) | No | `128` | ≥ 1; ≤ 16384 |
| `widthPercent` | Image Width (%) | No | `10` | ≥ 1; ≤ 100 |
| `position` | Position | No | `"bottom-right"` | `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `margin` | Margin (px) | No | `16` | ≥ 0; ≤ 4096 |
| `opacity` | Opacity (%) | No | `70` | ≥ 0; ≤ 100 |

Only the access stage provides the following request parameter; the upload stage has none. Enable it explicitly on the pipeline step. Instance defaults do not populate request parameters.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `watermark` | Watermark | No | — | — |

## Usage example

Create an upload-stage instance and add it to an upload pipeline. Upload a JPEG and check the text at the bottom right. To preserve originals, use an access-stage instance in the global access pipeline instead. Chinese text requires a server font with Chinese glyphs, optionally selected through `fontFile`.

```json
{
  "type": "text",
  "text": "Picloom"
}
```

## Behavior and limitations

Only static JPEG, PNG and WebP are supported; success returns `replace`. Text mode requires `text`; image mode requires a server-side `imagePath` pointing to a static PNG/JPEG/WebP. Relative font size and margins use the image’s shorter side; watermark image width uses the image width. Access processing applies the watermark by default. Enabling the `watermark` request parameter lets clients skip it with `watermark=false`. Zero opacity also skips processing.

Use upload-stage watermarking when stored content must always contain a watermark; do not rely on an access watermark that clients can disable.
