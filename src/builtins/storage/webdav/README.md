# WebDAV storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.zh-CN.md)

## Purpose

Store and read images through WebDAV.

`builtin.webdav` · `storage`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `endpoint` | WebDAV endpoint | Yes | — | immutable |
| `keyPrefix` | Directory Prefix | No | `""` | immutable |
| `timeoutMs` | Timeout (ms) | No | `30000` | ≥ 100; ≤ 120000 |
| `username` | Username | Yes | — | secret |
| `password` | Password or app password | Yes | — | secret |

No request parameters.

## Usage example

Use an existing WebDAV root URL and account credentials. Add the source to a storage group and upload profile, then upload, read and delete a test image to verify server support.

```json
{
  "endpoint": "https://dav.example.com/images/",
  "username": "YOUR_USERNAME",
  "password": "YOUR_APP_PASSWORD"
}
```

## Behavior and limitations

Uses Basic authentication with PUT, GET and DELETE, creating subdirectories when needed. Supply the final endpoint URL; redirects are refused. `keyPrefix` is a relative directory below that endpoint and must not be URL-encoded. Reads return streams; client redirects and enumeration are not provided. During recovery, HEAD 404 confirms absence; an existing object does not prove write ownership and yields an unknown result. Endpoint and prefix are immutable.
