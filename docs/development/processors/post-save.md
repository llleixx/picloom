# 保存后处理

保存后处理由后台执行。下面检查图片宽度，超过阈值就返回屏蔽意见，由 Picloom 更新状态；上传完成不代表审核完成，也不能保证图片在审核前未被访问。

## 最小实现

按[快速开始](../plugin-tooling.md)创建项目，将 `plugin.json.kind` 设为 `processor`，保留自己的 ID 和版本。将 `src/index.ts` 替换为以下外层代码，再用下一段实现替换注释行：

```ts
import { PluginError, type Definition } from "@picloom/plugin-sdk";
import manifest from "../plugin.json";

const { kind, apiVersion } = manifest;
if (kind !== "processor" || apiVersion !== 1)
  throw new Error("Expected processor plugin API 1");

export default {
  id: manifest.id,
  version: manifest.version,
  kind,
  apiVersion,
  // 将下一段实现放在这里
} satisfies Definition<"processor">;
```

<<< ../../../examples/post-save/src/index.ts#implementation

`process` 读取元数据，通过 `status` 返回 `pass` 或 `block`，并用 `details` 记录宽度和阈值。

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，创建保存后流水线，添加 **Example width review**，将 `maxWidth` 设为 `1280`。
2. 关联到上传配置。测试时不要启用上传缩放，否则审核的是缩放后的图片。
3. 分别上传宽度小于和大于 1280 的图片，等待后台操作完成。
4. 在图片详情查看结果：前者可访问，后者被屏蔽，详情记录实际宽度和阈值。

## 接口行为

配置与实例声明见[插件基础](../plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](../plugin-services.md)。

### process：执行保存后操作

宿主在后台按流水线顺序调用此方法。固定配置通过 `createInstance` 的闭包读取。

```ts
process(
  input: PostSaveProcessInput,
  context: PostSaveContext,
): Promise<PostSaveResult>;
```

#### 输入与上下文

| `input` 成员 | 类型 | 用法 |
| --- | --- | --- |
| `operationId` | `string` | 同一步骤重试时用于外部操作去重 |
| `record` | `FileContext` | 文件身份、来源、归属和当前归类。见[文件上下文](../plugin-services.md#文件上下文与归类) |
| `publicPath` | `string` | 含公开前缀的路径，不含域名 |
| `url` | `string` | 当前已发布图片的链接，未配置域名时可能是相对路径 |
| `file` | `FileInput` | 当前步骤处理的图片，可能已被前序步骤替换。通过 `metadata` 读元数据，调用 `openRead()` 读内容 |
| `currentDisposition` | `"pass" \| "block" \| "delete"` | 前序步骤累计的处置决定，初始为 `pass` |
| `previousResults` | `readonly Readonly<PostSaveStepResult>[]` | 本次尝试已完成的步骤结果，按执行顺序排列 |
| `limits` | `{ maxDimension: number; maxPixels: number }` | 单边像素数和总像素数上限 |
| `createOutput()` | `() => Promise<Output>` | 创建本次调用的替换输出 |

以上成员均由宿主提供，数据字段为只读。需要处理当前图片内容时使用 `file`，因为流水线中的替换内容可能尚未发布到 `url`。

`PostSaveStepResult` 包含 `status`、可选的 `organization` 和 `details`，以及 `stepId`、`pluginId`、`pluginVersion`（均为字符串）和 `completedAt`（Unix 毫秒时间戳）。步骤结果不含 `output`，整条流水线的结果序列化后最多 64 KiB。

通过 `context.signal` 传递取消信号，使用 `context.data` 在本次尝试的步骤间共享临时 JSON，使用 `context.organization` 查找或创建当前用户的分类。上下文的完整成员见[调用上下文](../plugin-services.md#调用上下文)。

#### 返回值

```ts
type PostSaveResult = {
  readonly organization?: OrganizationUpdate;
  readonly details?: Config;
} & (
  | { readonly status: "pass" | "block" | "delete" }
  | { readonly status: "replace"; readonly output: Output }
);
```

| `status` | 效果 |
| --- | --- |
| `pass` | 保留当前图片和累计处置，继续下一步 |
| `replace` | 后续步骤读取新内容。流水线成功且未决定删除时，发布替换内容并保留公开链接 |
| `block` | 累计屏蔽决定，继续下一步 |
| `delete` | 累计删除决定，继续下一步 |

处置按 `delete > block > pass` 累计。后续 `pass` 或 `replace` 不会撤销屏蔽或删除。

- `output` 仅用于 `replace`。调用本次的 `createOutput()`，等待 `output.write(stream)` 完成后返回，见[文件与输出](../plugin-services.md#文件与输出)。
- `organization` 可包含 `tagIds`、`collectionIds`（各为可选的只读字符串数组，每项最多 100 个 ID）。省略字段保留对应归类，传空数组清空。分类须属于当前图片的归属用户。
- `details` 是供图片详情和后续步骤读取的 JSON 对象。通知成功可返回 `{ status: "pass", details: { sent: true } }`。摘要中不要写入凭据或图片字节。

#### 失败行为

执行失败时抛出 [`PluginError`](../plugin-errors.md#pluginerror-字段)，不支持的输入使用错误码 `UNSUPPORTED`。后续步骤失败时，中间替换不会发布。已接受的屏蔽或删除决定仍会生效，任务也会停止自动重试。

允许重试的错误可能使流水线从第一步重新执行。发送通知或执行其他外部操作时，可用 `operationId` 去重。见[重试与幂等](../plugin-errors.md#重试与幂等)。
