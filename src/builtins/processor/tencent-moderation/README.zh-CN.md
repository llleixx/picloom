# 腾讯云图片审核

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/tencent-moderation/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/tencent-moderation/README.zh-CN.md)

## 用途

保存后调用腾讯云审核，返回放行、屏蔽或删除处置。

`builtin.tencent-moderation` · `processor` · `post_save`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。

### `post_save`

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `secretId` | 腾讯云密钥 ID | 是 | — | 敏感 |
| `secretKey` | 腾讯云密钥 | 是 | — | 敏感 |
| `region` | 区域 | 否 | `"ap-guangzhou"` | — |
| `bizType` | 审核策略 ID | 是 | — | — |
| `submissionMode` | 提交内容或公开 URL | 否 | `"content"` | `content`, `url` |
| `maxContentMiB` | 内容模式输入上限，MiB | 否 | `5` | ≥ 1；≤ 20 |
| `blockAction` | 违规时屏蔽或删除 | 否 | `"block"` | `block`, `delete` |
| `timeoutMs` | 请求超时，毫秒 | 否 | `30000` | ≥ 100；≤ 120000 |
| `interval` | GIF 抽帧间隔 | 否 | `5` | ≥ 1；≤ 1000 |
| `maxFrames` | GIF 最大抽帧数 | 否 | `5` | ≥ 1；≤ 400 |

无请求参数。

## 使用示例

在腾讯云准备审核凭证与策略 ID，将实例加入保存后流水线并关联上传配置。默认上传内容送审；使用测试图片上传后，在后台任务中检查审核结果。

```json
{
  "secretId": "YOUR_SECRET_ID",
  "secretKey": "YOUR_SECRET_KEY",
  "bizType": "YOUR_BIZ_TYPE"
}
```

## 行为与限制

`Pass` 返回 `pass`；`Review` 始终返回 `block`；`Block` 按 `blockAction` 返回 `block` 或 `delete`。`details` 提供建议、标签、评分和请求 ID 等摘要，不保留完整响应或 OCR 原文。内容模式先检查大小再读取并 Base64 编码，超限不重试；配置上限不改变服务商限制。URL 模式需要配置公开域名，且链接能被腾讯云访问。GIF 只审核抽样帧。审核在保存后执行，不保证图片发布前已完成审核。
