# 腾讯云图片审核

保存后调用腾讯云审核，返回放行、屏蔽或删除处置。

`picloom.tencent-moderation` · `processor` · `post_save`

## 开始使用

先按[安装插件](../../guide/plugins.md)安装 ZIP。在 **配置 → 流水线** 添加保存后步骤。

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

## 配置

| 字段             | 含义                  | 必填 | 默认值           | 约束              |
| ---------------- | --------------------- | ---- | ---------------- | ----------------- |
| `secretId`       | 腾讯云密钥 ID         | 是   | —                | 敏感              |
| `secretKey`      | 腾讯云密钥            | 是   | —                | 敏感              |
| `region`         | 区域                  | 是   | `"ap-guangzhou"` | —                 |
| `bizType`        | 审核策略 ID           | 是   | —                | —                 |
| `submissionMode` | 提交内容或公开 URL    | 是   | `"content"`      | `content`, `url`  |
| `maxContentMiB`  | 内容模式输入上限，MiB | 是   | `5`              | ≥ 1；≤ 20         |
| `blockAction`    | 违规时屏蔽或删除      | 是   | `"block"`        | `block`, `delete` |
| `timeoutMs`      | 请求超时，毫秒        | 是   | `30000`          | ≥ 100；≤ 120000   |
| `interval`       | GIF 抽帧间隔          | 是   | `5`              | ≥ 1；≤ 1000       |
| `maxFrames`      | GIF 最大抽帧数        | 是   | `5`              | ≥ 1；≤ 400        |

## 行为与限制

审核在图片发布后执行，完成前图片可能已被访问。`Pass` 放行，`Review` 屏蔽，`Block` 按 `blockAction` 屏蔽或删除。图片详情保留建议、标签、评分和请求 ID 摘要。

内容模式超出大小上限会审核失败，不自动重试；配置上限不改变腾讯云限制。URL 模式需配置公开图片域名，且腾讯云能访问该链接。GIF 仅审核抽样帧。

[扩展源码](https://github.com/llleixx/picloom-extensions/tree/main/plugins/tencent-moderation)
