# NodeImage Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/nodeimage/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/nodeimage/README.zh-CN.md)

## Purpose

Host images through the NodeImage API.

`builtin.nodeimage` · `storage`

## Configuration

Defaults initialize new drafts only; saving does not fill missing values. Required fields must be present in the submitted configuration.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `apiKey` | API key | Yes | — | secret |
| `redirect` | Redirect reads (302) | No | `true` | — |
| `timeoutMs` | Timeout (ms) | Yes | `30000` | ≥ 100; ≤ 120000 |

No request parameters.

## Usage example

Enter a NodeImage API key and connect the source through a storage group to an upload profile. Verify the public link after uploading, deletion follows the platform limitation below.

```json
{
  "redirect": true,
  "timeoutMs": 30000,
  "apiKey": "YOUR_API_KEY"
}
```

## Behavior and limitations

Uses the fixed service `https://api.nodeimage.com`. Uploads collect content in memory for a multipart form; returned image IDs locate remote objects rather than Picloom directory paths. Reads allow redirects by default and also support streams. Enumeration is not provided. Missing upload results cannot be reliably recovered; with a locator, recovery checks remote metadata and size. Deletion responses 404, 405 or 501 are treated as an unsupported operation: Picloom completes local cleanup without an error or retry. The remote image may remain and require manual deletion on NodeImage. Other authentication, network or service errors still fail.
