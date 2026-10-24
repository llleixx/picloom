# 宿主服务与运行上下文

`createInstance({ services })` 接收当前实例的宿主服务；运行方法的第二个参数 `context` 属于本次调用。不要将请求上下文保存在共享实例中。

## 值应该放在哪里

| 数据           | 使用方式                                      | 作用范围           |
| -------------- | --------------------------------------------- | ------------------ |
| 长期配置       | `configSchema` → `createInstance({ config })` | 当前配置实例       |
| 请求参数       | `paramsSchema` → `input.params`               | 本次上传或访问     |
| 密码、Token 等 | `x-sensitive` 字段与密钥服务                  | 当前实例，持久保存 |
| 运行状态       | `readState/updateState`                       | 当前实例，持久保存 |
| 临时共享数据   | `context.data`                                | 本次流水线执行     |
| 保存后结果摘要 | 返回 `details`                                | 文件的处理结果记录 |

## 密钥与运行状态

在配置字段中声明 `"x-sensitive": true`，然后在需要凭据的运行方法中读取：

```ts
const { value: secrets } = await services.readSecrets();
const token = String(secrets.token);
```

凭据可能在运行期间更新，应按需读取，不要永久缓存初始化时的值。

密钥和状态服务都返回 `{ value, version }`，更新时传入读到的版本。例如，在运行方法中更新状态的片段：

```ts
const state = await services.readState();
await services.updateState(
  { ...state.value, lastSuccessAt: Date.now() },
  state.version,
);
```

另一调用已更新时会发生版本冲突，应重新读取并重新决定更新内容，不能用旧对象盲目覆盖。状态服务不是密钥存储；凭证放入 `updateSecrets`，其持久化由部署密钥加密。

## 宿主服务接口

`services.images.sharp` 复用宿主图片库，示例见[上传处理](./processors/upload.md#最小实现)。`services.log(event)` 写入带实例 ID 的事件日志。

```ts
readSecrets(): Promise<{ value: Config; version: number }>;
updateSecrets(value: Config, expectedVersion: number): Promise<void>;
readState(): Promise<{ value: Config; version: number }>;
updateState(value: Config, expectedVersion: number): Promise<void>;
```

更新方法替换整个对象，不合并字段；版本不匹配则失败。`services` 没有单次请求的取消信号。日志、定位信息和结果详情不得包含凭证或带密钥的 URL。

## 调用上下文

运行方法接收 `context.signal`（取消信号）、`context.requestId`（调用标识）和 `context.log(event)`（带调用信息的事件日志）。将 `signal` 传给网络与流操作，资源释放见[错误与取消](./plugin-errors.md#取消与资源释放)。

处理阶段还增加 `data`：

| 上下文类型             | 使用位置                           | `data` 能力    |
| ---------------------- | ---------------------------------- | -------------- |
| `Context`              | 路径与存储运行方法                 | 无 `data`      |
| `CheckContext`         | 访问 `check`                       | 只读 `get`     |
| `PipelineContext`      | 访问 `process`                     | `get` 与 `set` |
| `UploadCheckContext`   | 上传 `check`，另有只读归类服务     | 只读 `get`     |
| `UploadProcessContext` | 上传 `process`，另有归类创建服务   | `get` 与 `set` |
| `PostSaveContext`      | 保存后 `execute`，另有归类创建服务 | `get` 与 `set` |

```ts
data.get(namespace: string): Json | undefined;
data.set(namespace: string, value: Json): void;
```

`get` 返回副本，未设置时返回 `undefined`；`set` 覆盖该命名空间。数据仅存在于本次流水线执行，总量上限 256 KiB，不能用它跨请求持久保存状态。

## 文件上下文与归类

上传、路径和保存后输入通过 `record: FileContext` 提供隔离快照：

```ts
interface FileContext {
  readonly id: string;
  readonly createdAt: number;
  readonly origin: {
    readonly kind: "upload" | "import";
    readonly userId: string | null;
  };
  readonly ownerId: string | null;
  readonly organization: {
    readonly tags: readonly { readonly id: string; readonly name: string }[];
    readonly collections: readonly {
      readonly id: string;
      readonly name: string;
    }[];
  };
}
```

`origin` 记录内容的上传或导入操作者，`ownerId` 决定图片归属；为注册用户 ID 时，也是分类范围。`null` 表示访客图片，其 `organization` 始终为空。插件不能指定或修改身份。归类输入含 ID 和名称；修改只返回 ID，重复项由核心去重并按 ID 排序，不表示主分类或显示顺序。

注册用户图片的上传 `check` 可通过 `context.organization` 查找；上传 `process` 和保存后 `execute` 还可创建。`record.ownerId === null` 时跳过归类：所有分类服务调用都会拒绝，非空标签或集合结果也会拒绝，空数组或省略字段是无操作。服务签名如下：

```ts
listTags(query?: { q?: string; limit?: number; offset?: number }): Promise<OrganizationPage>;
listCollections(query?: { q?: string; limit?: number; offset?: number }): Promise<OrganizationPage>;
ensureTag(input: { name: string }): Promise<OrganizationItem>;
ensureCollection(input: { name: string }): Promise<OrganizationItem>;
```

`OrganizationPage` 为 `{ items: OrganizationItem[], total: number }`，`OrganizationItem` 为 `{ id: string, name: string }`。列表默认 `limit=50`、`offset=0`，limit 范围 1–100。服务绑定本次图片归属，不接受跨用户参数。`ensure` 按规范化名称复用或创建，不修改已有名称或描述，也不自动关联图片。后续处理失败可能留下空分类。

例如在上传 `process` 或保存后 `execute` 中创建标签后，将 ID 放入返回结果：

```ts
const tag = await context.organization.ensureTag({ name: "Landscape" });
// 上传时还需返回 status: "pass" 或替换输出。
return { organization: { tagIds: [tag.id] } };
```

这些服务只在本次调用有效，遵从取消信号。路径、访问和存储没有归类创建服务；`InstanceServices` 不保存当前用户。

## 文件与输出

`FileInput` 由宿主提供，不是磁盘文件名：

| 成员         | 类型                                        | 可选 | 含义                           |
| ------------ | ------------------------------------------- | ---- | ------------------------------ |
| `metadata`   | `Readonly<Metadata>`                        | 否   | 只读元数据，字段见下表         |
| `openRead()` | `() => Promise<ReadableStream<Uint8Array>>` | 否   | 无参数，返回可读取图片内容的流 |

| `Metadata` 字段   | 类型             | 可选 | 单位 / 含义                |
| ----------------- | ---------------- | ---- | -------------------------- |
| `mimeType`        | `string \| null` | 否   | MIME 类型，未知时为 `null` |
| `byteSize`        | `number \| null` | 否   | 字节数，未知时为 `null`    |
| `width`、`height` | `number \| null` | 否   | 像素宽高，未知时为 `null`  |
| `animated`        | `boolean`        | 是   | 是否为动图                 |
| `alpha`           | `boolean`        | 是   | 是否有透明通道             |

`Output` 继承 `FileInput`，另有只读 `handle: string` 和 `write(stream: ReadableStream<Uint8Array>): Promise<void>`。`handle` 是宿主管理的不透明标识，不是文件路径。

在 `process` 中通过无参数的 `createOutput(): Promise<Output>` 获得输出，传入一个流并等待 `write` 完成；同一输出只允许写一次。不能自行创建句柄，或在调用结束后继续使用宿主提供的文件、输出和流。取消规则见 [错误、取消与并发](./plugin-errors.md#取消与资源释放)。
