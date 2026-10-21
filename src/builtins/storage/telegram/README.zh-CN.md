# Telegram 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/telegram/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/telegram/README.zh-CN.md)

## 用途

将原图作为 Telegram 机器人文档保存，不进行照片压缩。

`builtin.telegram` · `storage`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `botToken` | 机器人令牌 | 是 | — | 敏感 |
| `chatId` | 数字聊天 ID，可为负数 | 是 | — | 固定 |
| `timeoutMs` | 请求超时，毫秒 | 是 | `30000` | ≥ 100；≤ 120000 |

无请求参数。

## 使用示例

创建机器人，将其加入目标聊天并授予发送文档所需权限。填写令牌和数字聊天 ID，加入上传配置的存储组；上传图片后确认聊天中出现文档，公开链接可以读取。

```json
{
  "timeoutMs": 30000,
  "botToken": "123456:YOUR_BOT_TOKEN",
  "chatId": "-1001234567890"
}
```

## 行为与限制

插件将单文件限制为 20,000,000 字节，以便通过所用官方 API 下载。读取由应用转发，不向客户端暴露带 Bot 令牌的地址。不提供枚举或写入恢复；上传结果未知时不自动重复发送。删除受消息时间与机器人权限限制。Telegram 明确返回消息不存在或“message can't be deleted”（例如超过 48 小时）时，Picloom 完成本地清理，不报错或重试；后一种响应不保证远端消息已删除，也不能单凭该响应确定拒绝原因。认证、网络及其他 API 错误仍报错。聊天 ID 创建后不可修改。
