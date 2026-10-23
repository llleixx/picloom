# Local Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.zh-CN.md)

## Purpose

Store images in a local directory accessible to the application.

`builtin.local` · `storage`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration. Fields marked “immutable” cannot be changed after creation.

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

Supports streamed reads and writes, deletion and enumeration. Relative paths resolve against the application working directory. The root must be readable and writable and cannot be changed after instance creation. `.picloom/` stores operation records used to recognize repeated writes; do not remove it as cache. Enumeration skips symlinks, internal metadata and `.part` files.

Deletion uses the object location saved after a successful write or import. Without a confirmed location, deletion fails; manually mark the replica as deleted to end its management.

Import preserves the full storage key as the public path by default. “Public path strip depth” removes leading directories: stripping two levels maps `ab/cd/photo.jpg` to `photo.jpg`. Scan scope does not change the starting point, and the storage key stays unchanged. Too few directories fail; public path collisions are not overwritten, and registered storage objects are skipped.
