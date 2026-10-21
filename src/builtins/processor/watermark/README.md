# Watermark

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/watermark/README.zh-CN.md)

## Purpose

Add text or image watermarks during upload or access.

`builtin.watermark` · `processor` · `upload`, `access`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration.

### `upload / access`

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `type` | Watermark Type | Yes | `"text"` | `text`, `image` |
| `text` | Text | Text mode | — | Up to 500 characters; Required in text mode |
| `font` | Font | Text mode | `"sans"` | — |
| `fontFile` | Font File | No | — | — |
| `sizeMode` | Size Mode | Yes | `"relative"` | `relative`, `fixed` |
| `fontSizePercent` | Font Size (% of Short Side) | Text + relative | `3` | ≥ 0.1; ≤ 50 |
| `marginPercent` | Margin (% of Short Side) | Relative mode | `2` | ≥ 0; ≤ 49 |
| `fontSize` | Font Size (px) | Text + fixed | `32` | ≥ 1; ≤ 512 |
| `color` | Color | Text mode | `"#ffffff"` | — |
| `imagePath` | Image Path | Image mode | — | Required in image mode |
| `imageWidth` | Image Width (px) | Image + fixed | `128` | ≥ 1; ≤ 16384 |
| `widthPercent` | Image Width (%) | Image + relative | `10` | ≥ 1; ≤ 100 |
| `position` | Position | Yes | `"bottom-right"` | `top-left`, `top`, `top-right`, `left`, `center`, `right`, `bottom-left`, `bottom`, `bottom-right` |
| `margin` | Margin (px) | Fixed mode | `16` | ≥ 0; ≤ 4096 |
| `opacity` | Opacity (%) | Yes | `70` | ≥ 0; ≤ 100 |

Only the access stage provides the following request parameter; the upload stage has none. Enable it explicitly on the pipeline step. Instance defaults do not populate request parameters.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `watermark` | Watermark | No | — | — |

## Usage example

Create an upload-stage instance and add it to an upload pipeline. Upload a JPEG and check the text at the bottom right. To preserve originals, use an access-stage instance in the global access pipeline instead. Chinese text requires a server font with Chinese glyphs, optionally selected through `fontFile`.

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

## Behavior and limitations

Only static JPEG, PNG and WebP are supported; success returns `replace`. Text mode requires `text`; image mode requires a server-side `imagePath` pointing to a static PNG/JPEG/WebP. Relative font size and margins use the image’s shorter side; watermark image width uses the image width. Access processing applies the watermark by default. Enabling the `watermark` request parameter lets clients skip it with `watermark=false`. Zero opacity also skips processing.

Use upload-stage watermarking when stored content must always contain a watermark; do not rely on an access watermark that clients can disable.
