# Telegram 通知

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/README.zh-CN.md)

## 用途

保存后根据当前累计处置发送文字通知，可附带前序插件详情。

`builtin.telegram-notification` · `processor` · `post_save`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。

### `post_save`

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `botToken` | 机器人令牌 | 是 | — | 敏感 |
| `chatId` | 数字聊天 ID，可为负数 | 是 | — | — |
| `statuses` | 触发通知的累计状态 | 否 | `["block", "delete"]` | `pass`, `block`, `delete` |
| `includeDetails` | 附带前序插件详情 | 否 | `false` | — |
| `timeoutMs` | 请求超时，毫秒 | 否 | `10000` | ≥ 100；≤ 120000 |

无请求参数。

## 使用示例

让机器人具备目标聊天的发送权限。将本实例放在审核插件之后、保存后流水线末尾；下例仅在当前结果为屏蔽或删除时通知，并附带已有审核详情。用会触发审核处置的测试图片验证。

```json
{
  "botToken": "123456:YOUR_BOT_TOKEN",
  "chatId": "-1001234567890",
  "statuses": [
    "block",
    "delete"
  ],
  "includeDetails": true
}
```

## 行为与限制

消息包含当前累计状态、文件 ID 和链接；可附带 `previousResults` 中的 `details`，长消息截断为一条，关闭链接预览，不发送图片。未匹配状态时返回 `pass` 与 `{ "sent": false }`，发送成功返回 `pass` 与消息 ID，不覆盖已有处置。通知中的 `delete` 是当前决定，不代表副本已删除。网络结果未知时不自动重发，但整条流水线重新执行仍可能重复通知。
