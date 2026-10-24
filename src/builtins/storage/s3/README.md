# S3-Compatible Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.zh-CN.md)

Store images in S3 or an S3-compatible object store.

`builtin.s3` · `storage`

## Get started

This plugin is built in; no ZIP installation is needed. See the [plugin installation and usage guide](https://llleixx.github.io/picloom/guide/plugins.html) for the shared workflow.

In **Configuration → Storage sources**, create an **S3-Compatible Storage** source. Replace the endpoint, region, bucket and credential placeholders below with your provider’s values. Add the source to a storage group and select that group in an upload profile. Upload an image and open its Picloom link to verify access.

```json
{
  "multipartThresholdMiB": 64,
  "partSizeMiB": 16,
  "partConcurrency": 3,
  "keyPrefix": "",
  "forcePathStyle": true,
  "readMode": "proxy",
  "endpoint": "https://s3.example.com",
  "region": "your-region",
  "bucket": "picloom",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET_KEY"
}
```

## Configuration

Defaults initialize new configuration drafts; saving does not fill missing values. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `multipartThresholdMiB` | Multipart threshold (MiB) | Yes | `64` | ≥ 5; ≤ 5120; advanced |
| `partSizeMiB` | Part size (MiB) | Yes | `16` | ≥ 5; ≤ 512; advanced |
| `partConcurrency` | Part concurrency | Yes | `3` | ≥ 1; ≤ 8; advanced |
| `endpoint` | Endpoint | No | — | immutable |
| `region` | Region | Yes | — | immutable |
| `bucket` | Bucket | Yes | — | immutable |
| `keyPrefix` | Object prefix | No | `""` | immutable; advanced |
| `forcePathStyle` | Path-style addressing | Yes | `true` | immutable |
| `accessKeyId` | Access Key ID | Yes | — | secret |
| `secretAccessKey` | Secret Access Key | Yes | — | secret |
| `sessionToken` | Session Token | No | — | secret; advanced |
| `readMode` | Read mode | Yes | `"proxy"` | `proxy`, `signed`, `public` |
| `publicBaseUrl` | Public bucket root URL | In public mode | — | HTTP(S); optional path; no credentials, query or fragment |
| `signedUrlSeconds` | Signed URL lifetime (seconds) | In signed mode | `300` | ≥ 1; ≤ 604800 |

For ordinary reads, choose `proxy` to serve content through Picloom, `signed` to redirect to a temporary signed URL with the configured lifetime, or `public` to redirect to a public address. Only the selected mode's settings are shown. Requests that need content streams, including image processing, always use the S3 API.

In public mode, enter the bucket's public root URL in `publicBaseUrl`, for example `https://img.example.com/assets/`. An object key `photos/2026/a.png` produces `https://img.example.com/assets/photos/2026/a.png`; the bucket name is not added. Object paths are URL-encoded. The address must already serve the objects publicly; Picloom does not change bucket permissions or configure a CDN. Uploads, deletion and enumeration continue to use the S3 API.

## Behavior and limitations

Supports reads, writes, deletion and enumeration. Object keys are `keyPrefix/storageKey`; prefixes must not start or end with `/`. `forcePathStyle=true` uses path-style addressing; otherwise virtual-host addressing is used. Choose the mode required by your provider. Uploads at or above the threshold use multipart upload.

Deletion uses the object location saved after a successful write or import. Without a confirmed location, deletion fails; manually mark the replica as deleted to end its management.

Import preserves the full storage key as the public path by default. “Public path strip depth” removes leading directories: stripping two levels maps `ab/cd/photo.jpg` to `photo.jpg`. Scan scope does not change the starting point, and the storage key stays unchanged. Too few directories fail; public path collisions are not overwritten, and registered storage objects are skipped.
