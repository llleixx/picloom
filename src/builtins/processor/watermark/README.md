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
| `text` | Text | No | — | Up to 500 characters |
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

Both upload and access stages support the following request parameters. Enable the desired parameters in the pipeline step, then pass them in the upload request’s `params` JSON object or the image URL query string. Values override instance settings for that request only; omitted fields retain their configured values. Types and limits match the corresponding configuration fields.

| Request parameter | Configuration field |
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

`type`, `font`, `fontFile` and `imagePath` are instance settings only. When switching size modes, the merged configuration must contain the font size or image width and margin required by that mode. There is no separate watermark switch; enabling `watermarkOpacity` lets clients skip processing by passing `0`.

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

After enabling `watermarkText` and `watermarkOpacity`, pass `params={"watermarkText":"Alice","watermarkOpacity":50}` when uploading, or append `?watermarkText=Alice&watermarkOpacity=50` to an image URL.

## Behavior and limitations

Only static JPEG, PNG and WebP are supported; success returns `replace`. In text mode, processing is skipped if the merged text is omitted, empty or whitespace-only. Leave the instance text blank and enable `watermarkText` to add a watermark on demand through URL parameters. Image mode requires a server-side `imagePath` pointing to a static PNG/JPEG/WebP. Relative font size and margins use the image’s shorter side; watermark image width uses the image width. Processing is skipped when the effective opacity is zero.

When stored content must always contain a watermark, use upload-stage watermarking with nonblank text and nonzero opacity, and leave `watermarkText` and `watermarkOpacity` disabled.
