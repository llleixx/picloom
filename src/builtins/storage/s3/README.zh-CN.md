# S3 兼容存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.zh-CN.md)

## 用途

将图片保存到 S3 或兼容 S3 的对象存储。

`builtin.s3` · `storage`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `multipartThresholdMiB` | 分片上传阈值，MiB | 否 | `64` | ≥ 5；≤ 5120 |
| `partSizeMiB` | 分片大小，MiB | 否 | `16` | ≥ 5；≤ 512 |
| `partConcurrency` | 分片并发数 | 否 | `3` | ≥ 1；≤ 8 |
| `endpoint` | 服务端点 | 否 | — | 固定 |
| `region` | 区域 | 是 | — | 固定 |
| `bucket` | 桶名 | 是 | — | 固定 |
| `keyPrefix` | 对象／目录前缀 | 否 | `""` | 固定 |
| `forcePathStyle` | 路径寻址 | 否 | `true` | 固定 |
| `accessKeyId` | 访问密钥 ID | 是 | — | 敏感 |
| `secretAccessKey` | 访问密钥 | 是 | — | 敏感 |
| `sessionToken` | 临时会话令牌 | 否 | — | 敏感 |
| `redirect` | 普通读取允许 302 跳转 | 否 | `false` | — |
| `signedUrlSeconds` | 签名链接有效期，秒 | 否 | `300` | ≥ 1；≤ 604800 |

无请求参数。

## 使用示例

将端点、区域、桶名和凭证替换为服务商提供的值；区域没有默认值。创建存储源并加入上传配置使用的存储组，上传一张图片，检查桶中的对象与公开链接。

```json
{
  "endpoint": "https://s3.example.com",
  "region": "your-region",
  "bucket": "picloom",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET_KEY"
}
```

## 行为与限制

支持读写、删除、枚举和基于操作元数据的写入恢复。对象键为 `keyPrefix/storageKey`；前缀不要以 `/` 开头或结尾。`forcePathStyle=true` 使用路径寻址，否则使用虚拟主机寻址，按服务商要求选择。达到分片阈值时采用分片上传。开启 `redirect` 后，普通读取可返回有时效的签名链接；需要内容流时仍由应用读取。端点、区域、桶、对象前缀和寻址方式创建后不可修改。
