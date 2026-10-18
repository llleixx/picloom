# 错误、重试与取消

## PluginError

```ts
throw new PluginError("NETWORK", "Upload timed out", true, "unknown");
```

| 参数        | 含义                                 |
| ----------- | ------------------------------------ |
| `code`      | 通用原因，取值见下方                 |
| `message`   | 插件错误说明，不应包含凭证           |
| `retryable` | 是否允许后台任务重试，默认 `false`   |
| `outcome`   | 操作是否可能已经生效，默认 `unknown` |

`retryable` 与 `outcome` 相互独立。网络超时可以允许重试，但不能据此断言远端未写入。

只有确定操作没有生效，才使用 `notApplied`。例如真正发出写入请求之前的参数校验失败；上传后的连接中断通常应保留 `unknown`。

## 通用错误码

| 错误码           | 含义                     |
| ---------------- | ------------------------ |
| `INVALID_CONFIG` | 持久配置无效             |
| `INVALID_INPUT`  | 本次输入或参数无效       |
| `ACCESS_DENIED`  | 认证或权限失败           |
| `NOT_FOUND`      | 所需资源不存在           |
| `CONFLICT`       | 当前资源状态冲突         |
| `RESOURCE_LIMIT` | 大小、容量或配额超限     |
| `RATE_LIMITED`   | 请求频率或并发受限       |
| `UNSUPPORTED`    | 不支持该操作或格式       |
| `NETWORK`        | 网络连接、传输或超时     |
| `IO`             | 其他本地读写失败         |
| `INVALID_DATA`   | 内容损坏或响应不符合协议 |
| `SERVICE`        | 其他上游服务失败         |
| `FAILED`         | 未分类失败               |

核心将通用码映射为 `PLUGIN_` 前缀错误码；未知外部码归一为 `PLUGIN_FAILED`。核心不维护各插件的专属错误码列表。

## 重试需要幂等

后台调用带有 `operationId`，保存后步骤使用任务与步骤组合的操作标识。远端请求可能已经成功，只是响应丢失；插件和接收端应能识别重复调用。

没有可靠查询能力时，`recoverWrite` 应返回 `unknown`，不能为了推进状态而猜测失败。

## 取消与生命周期

将 `context.signal` 传给网络请求与流操作，在耗时阶段之间检查 `signal.throwIfAborted()`，退出前关闭自己持有的资源。

插件在主进程执行。超时只发出取消信号，核心不能强制停止不配合的 JavaScript 调用，也不能安全删除仍被它使用的临时文件。

测试至少覆盖成功、取消、明确未生效和可能已生效的失败。示例插件展示接口用法，不替代生产插件的故障处理。
