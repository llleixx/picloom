# S3 兼容存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/s3/README.zh-CN.md)

将图片保存到 S3 或兼容 S3 的对象存储。

`builtin.s3` · `storage`

## 开始使用

本插件已内置，无需安装 ZIP；通用操作见[安装与使用插件](https://llleixx.github.io/picloom/guide/plugins.html)。

在 **配置 → 存储源** 创建 **S3 兼容存储**，将下方端点、区域、桶名和凭证占位符替换为服务商提供的值。保存后将该源加入存储组，再在上传配置中选择该组。上传一张图片并打开返回的 Picloom 链接，验证上传和访问。

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

## 配置

默认值用于新建配置草稿，保存时不补值。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `multipartThresholdMiB` | 分片上传阈值，MiB | 是 | `64` | ≥ 5；≤ 5120；高级 |
| `partSizeMiB` | 分片大小，MiB | 是 | `16` | ≥ 5；≤ 512；高级 |
| `partConcurrency` | 分片并发数 | 是 | `3` | ≥ 1；≤ 8；高级 |
| `endpoint` | 服务端点 | 否 | — | 固定 |
| `region` | 区域 | 是 | — | 固定 |
| `bucket` | 桶名 | 是 | — | 固定 |
| `keyPrefix` | 对象／目录前缀 | 否 | `""` | 固定；高级 |
| `forcePathStyle` | 路径寻址 | 是 | `true` | 固定 |
| `accessKeyId` | 访问密钥 ID | 是 | — | 敏感 |
| `secretAccessKey` | 访问密钥 | 是 | — | 敏感 |
| `sessionToken` | 临时会话令牌 | 否 | — | 敏感；高级 |
| `readMode` | 读取方式 | 是 | `"proxy"` | `proxy`、`signed`、`public` |
| `publicBaseUrl` | 桶的公开根地址 | 公开地址模式下 | — | HTTP(S)，可带路径；不含账号密码、查询参数或片段 |
| `signedUrlSeconds` | 签名链接有效期，秒 | 签名模式下 | `300` | ≥ 1；≤ 604800 |

普通读取可选择 `proxy`（应用转发）、`signed`（签名重定向，使用配置的有效期）或 `public`（公开地址重定向）。界面只显示所选方式对应的配置项。图片处理等需要内容流的请求始终通过 S3 API 读取。

公开地址模式下，在 `publicBaseUrl` 填写桶的公开根地址，例如 `https://img.example.com/assets/`。对象键 `photos/2026/a.png` 会拼成 `https://img.example.com/assets/photos/2026/a.png`，不额外添加桶名，对象路径会进行 URL 编码。该地址需要已经允许公开访问对象；Picloom 不修改桶权限或配置 CDN。上传、删除和枚举仍使用 S3 API。

## 行为与限制

支持读写、删除和枚举。对象键为 `keyPrefix/storageKey`；前缀不要以 `/` 开头或结尾。`forcePathStyle=true` 使用路径寻址，否则使用虚拟主机寻址，按服务商要求选择。达到分片阈值时采用分片上传。

删除使用写入成功或导入时保存的对象定位。缺少已确认的定位时会记录删除失败，可将副本人工标记为已删除以结束管理。

导入默认保留完整存储路径作为公开路径；「公开路径去除层数」可去除开头目录，例如 `ab/cd/photo.jpg` 去除两层后使用 `photo.jpg`。扫描范围不影响计算起点，实际存储路径不变。路径不足计为失败，公开路径冲突不覆盖，已登记的存储对象跳过。
