# 插件能力与返回协议

SDK 的类型入口是 [`plugin-sdk/index.ts`](https://github.com/llleixx/picloom/blob/main/plugin-sdk/index.ts)，接口定义在 [`api.ts`](https://github.com/llleixx/picloom/blob/main/plugin-sdk/api.ts)。内置和外部插件使用相同协议，当前 `apiVersion` 为 `1`。

## 三类插件

| `kind`      | 运行方法                    | 返回值                           |
| ----------- | --------------------------- | -------------------------------- |
| `path`      | `generate(input, context)`  | `logicalKey`，可选 `storageKey`  |
| `storage`   | `write` / `read` / `delete` | 定位信息、读取结果、无返回值     |
| `processor` | 按 `stages` 提供处理能力    | 上传、访问、保存后各自的结果协议 |

`createInstance` 接收实例 ID、只读配置和宿主服务。可提供 `dispose` 释放连接等资源。

## 文件输入与输出

`FileInput` 包含只读元数据和 `openRead()`，不要假设输入一定是本地路径。元数据字段可能为 `null`。

处理插件通过 `createOutput()` 获取宿主管理的输出，用 `output.write(stream)` 写入一次，再返回 `{ status: "replace", output }`。这样输出会计入宿主临时空间预算；不要返回自行创建的句柄。

访问插件通过 `getFile()` 延迟读取原图，仅检查参数时无需下载。`cacheable: false` 用于不应共享派生缓存的访问插件。

## 存储读取

```ts
type ReadResult =
  | {
      type: "stream";
      stream: ReadableStream<Uint8Array>;
      mimeType?: string;
      byteSize?: number;
    }
  | { type: "redirect"; url: string; expiresAt?: number };
```

`mode: "auto"` 允许流或跳转；`mode: "stream"` 必须返回流，图片处理需要实际内容。

`expiresAt` 是 **Unix 毫秒时间戳**。核心验证 URL 和有效期，并将跳转缓存时间限制在链接剩余寿命内。

## 存储写入与恢复

`write` 接收 `operationId`、`fileId`、`storageKey` 和文件，返回可选 `locator`。定位信息可以是字符串、JSON 对象或 `null`，会传回后续读取、删除和恢复调用。

可选的 `recoverWrite` 返回：

- `stored`：确认写入，必要时附定位信息。
- `notStored`：确认未写入。
- `unknown`：仍无法确定。

不要用一次查询失败来推断 `notStored`。可选的 `listFiles` 供导入使用，返回文件列表和下一页游标。

## 处理阶段

上传与访问的 `check` 返回 `applicable`、`noop` 或 `unsupported`；`process` 返回 `pass`、带输出的 `replace` 或带原因的 `reject`。

### 保存后结果与处置

保存后阶段的 `execute` 接收 `input.currentStatus`（当前累计处置）和 `input.previousResults`（本次执行中已完成步骤的结果快照）。前序结果包含步骤 ID、插件 ID、版本、完成时间及原始返回结果；修改快照不会改变核心记录。

```ts
interface PostSaveResult {
  status: "pass" | "block" | "delete";
  details?: Config;
  overrideStatus?: "pass" | "block" | "delete";
}
```

例如，审核步骤返回屏蔽建议后，下一个插件收到的输入片段如下（ID、时间与审核内容均为示意）：

```json
{
  "currentStatus": "block",
  "previousResults": [
    {
      "stepId": "step-moderation",
      "pluginId": "builtin.tencent-moderation",
      "pluginVersion": "1.0.0",
      "completedAt": 1792310400000,
      "status": "block",
      "details": {
        "suggestion": "Review",
        "label": "Porn",
        "score": 65,
        "requestId": "example-request-id"
      }
    }
  ]
}
```

`previousResults` 按执行顺序排列，不包含当前步骤。`status` 和可选的 `overrideStatus` 是各步骤的原始意见；`currentStatus` 才是累计结果。`details` 由对应插件定义，没有详情的步骤会省略该字段。

每步必须返回 `status`。累计处置初始为 `pass`，默认按 `delete > block > pass` 更新；返回 `overrideStatus` 时，以它覆盖当前累计处置。覆盖只作用于当前步骤，后续步骤仍可改变结果。例如：

| 步骤 | 返回值 | 累计处置 |
| --- | --- | --- |
| 初审 | `{ status: "block", details: { reason: "review" } }` | `block` |
| 复核 | `{ status: "pass", overrideStatus: "pass" }` | `pass` |
| 通知 | `{ status: "pass" }` | `pass` |

`block/delete` 不停止后续步骤，也不立即执行物理删除。核心在本次执行结束时应用累计处置；后续插件抛错时，已完成步骤的处置和结果仍会保存。非法返回值不参与累计。累计为 `block/delete` 时任务失败后不再自动重试；为 `pass` 时按原有规则重试整条流水线，前序输入从空列表开始。

每一步的结果都会记录，包括没有 `details` 的步骤。`details` 只保存简要 JSON 对象；整条执行的结果总量受 64 KiB 限制，不要放入密钥或图片字节。

`context.data` 可在同一次流水线执行中按命名空间传递 JSON；检查阶段只读，处理阶段可写。它不是跨请求数据库。
