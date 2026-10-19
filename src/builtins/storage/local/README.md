# Local storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.zh-CN.md)

## Purpose

Store images in a local directory accessible to the application.

`builtin.local` · `storage`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `root` | Root directory | Yes | — | immutable |

No request parameters.

## Usage example

Create a storage source, add it to a storage group, and select that group in an upload profile. Upload an image and check both the file under the root directory and its public link. Mount the directory when using Docker to persist images.

```json
{
  "root": "./images"
}
```

## Behavior and limitations

Supports streamed reads and writes, deletion, enumeration and write recovery. Relative paths resolve against the application working directory. The root must be readable and writable and cannot be changed after instance creation. `.picloom/` stores operation records used for write recovery; do not remove it as cache. Enumeration skips symlinks, internal metadata and `.part` files.
