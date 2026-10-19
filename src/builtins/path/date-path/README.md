# Date Path

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/path/date-path/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/path/date-path/README.zh-CN.md)

## Purpose

Build paths from the UTC upload date and file ID.

`builtin.date-path` · `path`

## Configuration

No configuration fields; use `{}`.

No request parameters.

## Usage example

Create a path instance and select it in an upload profile. A JPEG uploaded on 2026-10-18 produces `2026/10/18/<fileId>.jpg`; with public prefix `/i/`, its URL path is `/i/2026/10/18/<fileId>.jpg`.

```json
{}
```

## Behavior and limitations

The final image MIME type determines the extension; the original filename is ignored. Only `logicalKey` is returned, so the storage key matches the path inside the public prefix. Dates use UTC and may differ from local dates.
