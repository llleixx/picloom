# OpenList Storage

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

To register existing images, choose **Import** on the storage source page. The scan scope is a directory relative to `root`; leave it empty to scan the whole mount directory. With `root=/Images` and scope `2026`, `/Images/2026/photo.jpg` retains the storage key `2026/photo.jpg`. Setting public-path directory stripping to `1` uses `photo.jpg` for the public path without moving the remote file.

## Behavior and limitations

Object paths combine `root` and the storage key. Writes, reads and deletes depend on the upstream mount. Normal reads redirect to the upstream download URL by default; disabling redirects or requesting a stream proxies the content without forwarding the API token. Write recovery returns unknown because object presence cannot identify the write operation. Endpoint and mount directory are immutable.

A refused connection confirms that the request was not delivered: the write fails, and background tasks may retry under the existing policy. Interrupted transfers, response timeouts and invalid responses can leave the write outcome unknown; writes are not automatically retried in these cases.

Import scans subdirectories through paginated directory listings without downloading images. The token must have directory access; separate directory passwords are not supported. Listings may use OpenList’s cache. Avoid adding, removing or moving entries during a scan. Permission and listing errors fail the scan rather than silently skipping directories. Picloom handles duplicate imports and public-path conflicts.
