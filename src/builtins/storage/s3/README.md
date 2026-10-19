# S3-Compatible Storage

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.zh-CN.md)

## Purpose

Store images in S3 or an S3-compatible object store.

`builtin.s3` · `storage`

## Configuration

The core fills defaults when saving an instance. “Required” means a value must be supplied because no default is available. Fields marked “immutable” cannot be changed after creation.

| Field | Meaning | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `multipartThresholdMiB` | Multipart threshold (MiB) | No | `64` | ≥ 5; ≤ 5120 |
| `partSizeMiB` | Part size (MiB) | No | `16` | ≥ 5; ≤ 512 |
| `partConcurrency` | Part concurrency | No | `3` | ≥ 1; ≤ 8 |
| `endpoint` | Endpoint | No | — | immutable |
| `region` | Region | Yes | — | immutable |
| `bucket` | Bucket | Yes | — | immutable |
| `keyPrefix` | Object prefix | No | `""` | immutable |
| `forcePathStyle` | Path-style addressing | No | `true` | immutable |
| `accessKeyId` | Access Key ID | Yes | — | secret |
| `secretAccessKey` | Secret Access Key | Yes | — | secret |
| `sessionToken` | Session Token | No | — | secret |
| `redirect` | Redirect reads (302) | No | `false` | — |
| `signedUrlSeconds` | Signed URL lifetime (seconds) | No | `300` | ≥ 1; ≤ 604800 |

No request parameters.

## Usage example

Replace the endpoint, region, bucket and credentials with provider values; region has no default. Create a storage source and add it to the upload profile’s storage group. Upload an image and verify the object and public link.

```json
{
  "endpoint": "https://s3.example.com",
  "region": "your-region",
  "bucket": "picloom",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET_KEY"
}
```

## Behavior and limitations

Supports reads, writes, deletion, enumeration and recovery using operation metadata. Object keys are `keyPrefix/storageKey`; prefixes must not start or end with `/`. `forcePathStyle=true` uses path-style addressing; otherwise virtual-host addressing is used. Choose the mode required by your provider. Uploads at or above the threshold use multipart upload. With `redirect` enabled, normal reads may return an expiring signed URL; stream requests still read through the application. Endpoint, region, bucket, prefix and addressing mode are immutable.

Import preserves the full storage key as the public path by default. “Public path strip depth” removes leading directories: stripping two levels maps `ab/cd/photo.jpg` to `photo.jpg`. Scan scope does not change the starting point, and the storage key stays unchanged. Too few directories fail; public path collisions are not overwritten, and registered storage objects are skipped.
