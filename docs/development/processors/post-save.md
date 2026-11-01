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

<span id="接入并验证"></span>

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

后台任务按顺序调用 `process`，不接受请求参数。

```ts
process(input: {
  readonly operationId: string;
  readonly record: FileContext;
  readonly publicPath: string;
  readonly url: string;
  readonly file: FileInput;
  readonly currentDisposition: PostSaveDisposition;
  readonly previousResults: readonly Readonly<PostSaveStepResult>[];
  limits: { maxDimension: number; maxPixels: number };
  createOutput(): Promise<Output>;
}, context: PostSaveContext): Promise<PostSaveResult>;
```

结果必须包含 `status`：

| `status`  | 其他必需字段     | 行为                             |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `pass`    | 无               | 保留当前内容及累计处置           |
| `replace` | `output: Output` | 接受本次输出，后续步骤读取新内容 |
| `block`   | 无               | 累计屏蔽决定，继续后续步骤       |
| `delete`  | 无               | 累计删除决定，继续后续步骤       |

各状态均可附 `organization: OrganizationUpdate` 和 `details: Config`。通知插件可返回 `{ status: "pass", details: { sent: true } }`。此阶段没有“不适用时跳过”的选项；不支持的输入应抛出 `PluginError("UNSUPPORTED", reason)`。

`file` 是此前步骤接受的当前内容；`createOutput()` 和 `limits` 的规则与[上传处理](./upload.md#接口行为)相同。输出必须由本次调用创建并写入完成。`record` 包含文件 ID、时间、来源、归属及当前有效归类；归类字段省略表示保留，空数组清空，每项最多 100 个 ID。查找和创建服务见[文件上下文与归类](../plugin-services.md#文件上下文与归类)。

`operationId` 可用于远端幂等处理；`publicPath` 含公开前缀、不含域名，`url` 未配置域名时可能是相对路径。URL 始终指向当前已发布内容，可能与流水线内尚未发布的 `file` 不同。

`currentDisposition` 为只读的 `pass | block | delete`，表示每步开始前本次尝试的累计决定，初始为 `pass`。删除优先于屏蔽，屏蔽优先于通过；后续 `pass` 或 `replace` 不会解除屏蔽或撤销删除。`block/delete` 不终止后续步骤，后续通知可以继续读取这一决定。

`previousResults` 按顺序提供本次尝试已完成步骤的隔离快照：`status`、可选归类和摘要，以及 `stepId`、`pluginId`、`pluginVersion`、Unix 毫秒时间 `completedAt`。其中不保存或传递 `Output`。结果表示步骤当时接受的修改，文件详情中的关系才是当前归类。总量上限为 64 KiB，不应放入凭证或图片字节。

<span id="扩展与约束"></span>

## 提交与失败

每步完整校验输出、归类和摘要后才接受其结果。同一步的非法分类会使整个结果失败；需要审核独立生效时，将审核与归类配置为两个步骤，让归类步骤读取前序 `details`。

整条处理成功后，替换结果作为新图片记录写入副本，至少一份成功后接管原公开链接，图片 ID 更新。归属、当前归类、处理结果及任务保留在新记录中，旧图随后清理；新图不再触发保存后流水线。累计屏蔽可与替换同时生效；累计删除时不保存替换内容或提交归类，进入整图删除。

处理途中失败时不发布任何中间替换，但此前已接受的屏蔽、删除与摘要仍会提交；没有删除决定时也提交已接受的归类。只写插件明确修改的归类字段；人工与插件对同一字段的修改按提交顺序生效。已被删除的分类在提交时排除，文件进入删除流程后不再写新归类或覆盖删除状态。

失败或重启后的重试可能重新执行整条流水线，包括处理和通知。累计为 `block/delete` 的失败不自动重试；为 `pass` 时，可重试错误按次数限制重试。只有 `ready` 文件可重新执行处理；屏蔽文件需先由管理员解除屏蔽，删除失败通过删除任务处理。

`context.data` 用于本次流水线的临时 JSON，不跨请求或处理重试保存；持久运行数据见[状态服务](../plugin-services.md#密钥与运行状态)。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
