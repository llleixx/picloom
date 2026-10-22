# Telegram 存储

将原图作为 Telegram 机器人文档保存，不进行照片压缩。

`picloom.telegram-storage` · `storage`

## 开始使用

先按[安装插件](../../guide/plugins.md)安装 ZIP。在 **配置 → 存储源** 选择本插件。

创建机器人，将其加入目标聊天并授予发送文档所需权限。填写令牌和数字聊天 ID，加入上传配置的存储组；上传图片后确认聊天中出现文档，公开链接可以读取。

```json
{
  "timeoutMs": 30000,
  "botToken": "123456:YOUR_BOT_TOKEN",
  "chatId": "-1001234567890"
}
```

## 配置

默认值用于新配置；标为“固定”的字段创建后不可修改。

| 字段        | 含义                  | 必填 | 默认值  | 约束            |
| ----------- | --------------------- | ---- | ------- | --------------- |
| `botToken`  | 机器人令牌            | 是   | —       | 敏感            |
| `chatId`    | 数字聊天 ID，可为负数 | 是   | —       | 固定            |
| `timeoutMs` | 请求超时，毫秒        | 是   | `30000` | ≥ 100；≤ 120000 |

## 行为与限制

单文件上限为 20,000,000 字节。读取由 Picloom 转发，不向访问者暴露机器人令牌。不支持导入或写入恢复，上传结果未知时不自动重复发送。聊天 ID 创建后不可修改。

删除受消息时间与机器人权限限制。Telegram 返回消息不存在或 “message can't be deleted”（例如超过 48 小时）时，Picloom 会移除本地记录，远端消息可能仍存在。其他 API、认证或网络错误仍会报错。

[扩展源码](https://github.com/llleixx/picloom-extensions/tree/main/plugins/telegram-storage)
