# Image Processing

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/sharp/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/sharp/README.zh-CN.md)

## Purpose

Resize images or change format and quality during upload or access.

`builtin.sharp` · `processor` · `upload`, `access`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration.

Upload instances accept all fields below. Access instances use `{}` as configuration. Both stages accept `w`, `h`, `fit`, `q` and `format` as request parameters, with the same constraints; explicitly enable them on the pipeline step.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `w` | Width | No | — | ≥ 1 |
| `h` | Height | No | — | ≥ 1 |
| `fit` | Fit | No | — | `inside`, `cover`, `contain`, `fill` |
| `q` | Quality | No | — | ≥ 1; ≤ 100 |
| `format` | Output format | No | — | `jpeg`, `png`, `webp` |

## Usage example

Upload stage: use the configuration below, add the instance to an upload pipeline and select it in an upload profile. Uploading a JPEG produces a WebP no wider than 1280 pixels. Access stage: use `{}` as instance configuration, add it to the global access pipeline, enable `w`, and append `?w=320` to an image URL.

```json
{
  "w": 1280,
  "format": "webp",
  "q": 80
}
```

## Behavior and limitations

Only static JPEG, PNG and WebP are supported; converting an image with transparency to JPEG is unsupported. Upload request parameters override matching fixed settings; access transforms are specified only through request parameters. No transform parameters means no operation; success returns `replace`. `fit` requires at least one dimension and defaults to `inside` when omitted. An omitted format preserves the input format. JPEG/WebP quality defaults to 80; setting PNG quality enables palette encoding.

### Resize examples

For a 1600 × 900 source and `w=640&h=480`:

| `fit` | Behavior | No |
| --- | --- | --- |
| `inside` | Scale proportionally without cropping | 640 × 360 |
| `cover` | Fill the target, cropping left and right | 640 × 480 |
| `contain` | Scale proportionally, adding space above and below | 640 × 480 |
| `fill` | Stretch to the target dimensions | 640 × 480, changing aspect ratio |

Specify only `w` or `h` for proportional resizing. `q` is encoding quality, not a percentage of output file size. Access example: `<imageURL>?w=640&h=480&fit=cover&format=webp`.
