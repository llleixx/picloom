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

保存后阶段使用 `execute`，返回 `pass`、`block` 或 `delete`。可附 `details`，用于保存简要 JSON 结果；整条任务的处理结果总量受 64 KiB 限制，不要放入密钥或图片字节。

`context.data` 可在同一次流水线执行中按命名空间传递 JSON；检查阶段只读，处理阶段可写。它不是跨请求数据库。
