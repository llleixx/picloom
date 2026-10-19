# Random Path

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/path/random-path/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/path/random-path/README.zh-CN.md)

## Purpose

The default path plugin derives a stable 32-character filename from the random file ID.

`builtin.random-path` · `path`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `directoryDepth` | Directory shard depth | No | `2` | `0`, `1`, `2` |

No request parameters.

## Usage example

Create an instance and select it in an upload profile. For file ID `12345678-1234-1234-1234-123456789abc` and PNG content, the public key is `12345678123412341234123456789abc.png` and the storage key is `12/34/12345678123412341234123456789abc.png`.

```json
{
  "directoryDepth": 2
}
```

## Behavior and limitations

Each directory level uses two filename characters; `0` disables sharding. Sharding affects storage only, not public links. The same file ID produces the same path, without dates or original filenames. Supported MIME types are JPEG, PNG, WebP, SVG, GIF, AVIF and TIFF; the upload profile must also allow the format.

When importing existing images, set “Public path strip depth” to the original shard depth to retain flat public URLs. For example, stripping two directories maps `ab/cd/abcdef.jpg` to `abcdef.jpg` without changing its storage key.
