# 腾讯云图片审核

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/tencent-moderation/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/tencent-moderation/README.zh-CN.md)

## 用途

保存后调用腾讯云审核，返回放行、屏蔽或删除处置。

`builtin.tencent-moderation` · `processor` · `post_save`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。

### `post_save`

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `secretId` | 腾讯云密钥 ID | 是 | — | 敏感 |
| `secretKey` | 腾讯云密钥 | 是 | — | 敏感 |
| `region` | 区域 | 是 | `"ap-guangzhou"` | — |
| `bizType` | 审核策略 ID | 是 | — | — |
| `submissionMode` | 提交内容或公开 URL | 是 | `"content"` | `content`, `url` |
| `maxContentMiB` | 内容模式输入上限，MiB | 是 | `5` | ≥ 1；≤ 20 |
| `blockAction` | 违规时屏蔽或删除 | 是 | `"block"` | `block`, `delete` |
| `timeoutMs` | 请求超时，毫秒 | 是 | `30000` | ≥ 100；≤ 120000 |
| `interval` | GIF 抽帧间隔 | 是 | `5` | ≥ 1；≤ 1000 |
| `maxFrames` | GIF 最大抽帧数 | 是 | `5` | ≥ 1；≤ 400 |

无请求参数。

## 使用示例

在腾讯云准备审核凭证与策略 ID，将实例加入保存后流水线并关联上传配置。默认上传内容送审；使用测试图片上传后，在后台任务中检查审核结果。

```json
{
  "region": "ap-guangzhou",
  "submissionMode": "content",
  "maxContentMiB": 5,
  "blockAction": "block",
  "timeoutMs": 30000,
  "interval": 5,
  "maxFrames": 5,
  "secretId": "YOUR_SECRET_ID",
  "secretKey": "YOUR_SECRET_KEY",
  "bizType": "YOUR_BIZ_TYPE"
}
```

## 行为与限制

`Pass` 返回 `pass`；`Review` 始终返回 `block`；`Block` 按 `blockAction` 返回 `block` 或 `delete`。`details` 提供建议、标签、评分和请求 ID 等摘要，不保留完整响应或 OCR 原文。内容模式先检查大小再读取并 Base64 编码，超限不重试；配置上限不改变服务商限制。URL 模式需要配置公开域名，且链接能被腾讯云访问。GIF 只审核抽样帧。审核在保存后执行，不保证图片发布前已完成审核。
