# WebDAV Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.zh-CN.md)

## Purpose

Store and read images through WebDAV.

`builtin.webdav` · `storage`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `endpoint` | WebDAV endpoint | Yes | — | immutable |
| `keyPrefix` | Directory Prefix | No | `""` | immutable |
| `timeoutMs` | Timeout (ms) | Yes | `30000` | ≥ 100; ≤ 120000 |
| `username` | Username | Yes | — | secret |
| `password` | Password or app password | Yes | — | secret |

No request parameters.

## Usage example

Use an existing WebDAV root URL and account credentials. Add the source to a storage group and upload profile, then upload, read and delete a test image to verify server support.

```json
{
  "keyPrefix": "",
  "timeoutMs": 30000,
  "endpoint": "https://dav.example.com/images/",
  "username": "YOUR_USERNAME",
  "password": "YOUR_APP_PASSWORD"
}
```

Choose **Import** on the storage source page to register existing images. The scan scope is relative to `endpoint` plus `keyPrefix`; leave it empty to scan the whole root. With endpoint `https://dav.example.com/images/` and prefix `archive`, the remote file `archive/2026/photo.jpg` has storage key `2026/photo.jpg`. Stripping one public-path directory uses `photo.jpg` without moving the remote file.

## Behavior and limitations

Uses Basic authentication with PUT, GET and DELETE, creating subdirectories when needed. Supply the final endpoint URL; redirects are refused. `keyPrefix` is a relative directory below that endpoint and must not be URL-encoded. Reads return streams; client redirects are not provided. Interrupted writes may have stored the object; retrying uses conditional creation and cannot overwrite an existing object. Endpoint and prefix are immutable.

Deletion uses the object location saved after a successful write or import. Without a confirmed location, deletion fails; manually mark the replica as deleted to end its management.

Import requires server support for `PROPFIND` and directory access permission. It scans one level at a time without downloading images, reusing Picloom’s duplicate and path-conflict checks. WebDAV has no standard pagination: resuming a directory fetches its listing again. Avoid adding, removing or moving files during a scan. Each directory response is limited to 8 MiB; exceeding this fails the scan. Narrow the scope, or split the directory if that directory itself is too large. Directory read failures and invalid paths are reported rather than silently skipped.
