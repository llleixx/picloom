# 内置插件

内置插件与外部插件使用相同的 SDK。下表列出各插件的用途，具体字段见管理界面的配置表单。

| 插件 ID                      | 能力               | 主要配置或注意事项                              |
| ---------------------------- | ------------------ | ----------------------------------------------- |
| `builtin.date-path`          | 日期路径           | 按 UTC 日期与文件 ID 生成路径                   |
| `builtin.random-path`        | 随机路径           | 默认路径插件，32 位随机文件名；目录层数只影响存储                        |
| `builtin.local`              | 本地存储           | 根目录为服务可见路径，需可读写并持久化          |
| `builtin.s3`                 | S3 兼容存储        | 端点、区域、桶、访问凭证、前缀；可选签名跳转    |
| `builtin.webdav`             | WebDAV 存储        | 服务地址、认证与目标目录配置                    |
| `builtin.openlist`           | OpenList 存储      | 服务连接和存储路径；能力取决于上游              |
| `builtin.nodeimage`          | NodeImage 存储     | 服务凭证；先确认上游删除能力                    |
| `builtin.telegram`           | Telegram 存储      | Bot 与聊天目标；读取经过代理以避免暴露 Bot 令牌 |
| `builtin.sharp`              | 上传／访问图片变换 | 尺寸、格式、质量；访问参数需显式启用            |
| `builtin.watermark`          | 上传／访问水印     | 文字或图片、大小、位置和透明度                  |
| `builtin.tencent-moderation` | 保存后内容审核     | 凭证、模式、输入大小上限、命中处理策略          |
| `builtin.webhook`            | 保存后通知         | 目标 URL、可选 Bearer 令牌、超时                |

## S3 配置

字段填写与读写验证见 [添加 S3 兼容存储](../guide/storage.md#添加-s3-兼容存储)。启用 302 重定向时，分享 Picloom 的公开链接，避免分享会过期的签名地址。

## Webhook 通知

Webhook 用于保存后流水线，向目标链接发送 JSON 格式的 HTTP POST。配置 Bearer 令牌后会附带 `Authorization` 请求头；超时默认 10 秒。

载荷示例（ID、URL 和图片属性均为示意值）：

```json
{
  "event": "file.saved",
  "operationId": "示例操作ID",
  "fileId": "示例文件ID",
  "url": "https://img.example.com/i/9b7c6d5e4f304162a8b9c0d1e2f34567.jpg",
  "mimeType": "image/jpeg",
  "byteSize": 123456,
  "width": 1600,
  "height": 900
}
```

图片元数据尚不可知时，相应字段可能为 `null`。接收端返回 2xx 表示成功；重定向不会被自动跟随。网络错误、超时、429 和 5xx 可触发后台重试，接收端应按 `Idempotency-Key` 请求头去重，其值与 `operationId` 一致。

后台生成完整图片链接需要设置站点或图片域名，见 [域名与反向代理](../operations/proxy.md)。

## 导入、恢复和删除

不是所有存储都支持文件枚举或可靠的写入恢复。是否显示导入入口取决于实例的枚举能力；不能确认的远端操作会保留未知状态，需要进一步确认结果。

配置字段的完整定义位于 [`src/builtins`](https://github.com/llleixx/picloom/tree/main/src/builtins)。
