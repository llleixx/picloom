# OpenList storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.zh-CN.md)

## Purpose

Use storage mounted in OpenList through its API.

`builtin.openlist` · `storage`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `endpoint` | Endpoint | Yes | — | immutable |
| `root` | Mount directory | Yes | — | immutable |
| `token` | API token | Yes | — | secret |
| `redirect` | Redirect reads (302) | No | `true` | — |
| `timeoutMs` | Timeout (ms) | No | `30000` | ≥ 100; ≤ 120000 |

No request parameters.

## Usage example

Set the OpenList service URL, mount directory and API token. Add the source to the upload profile’s storage group, then upload an image and verify the mounted directory and returned link.

```json
{
  "endpoint": "https://openlist.example.com",
  "root": "/Images",
  "token": "YOUR_API_TOKEN"
}
```

## Behavior and limitations

Object paths combine `root` and the storage key. Writes, reads and deletes depend on the upstream mount. Normal reads redirect to the upstream download URL by default; disabling redirects or requesting a stream proxies the content without forwarding the API token. Enumeration is not provided. Write recovery returns unknown because object presence cannot identify the write operation. Endpoint and mount directory are immutable.
