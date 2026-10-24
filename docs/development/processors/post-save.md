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

`execute` 读取元数据，通过 `disposition.value` 返回 `pass` 或 `block`，并用 `details` 记录宽度和阈值。

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

此阶段仅提供 `execute`，没有请求参数、`check/process` 或替换图片的输出接口。

### execute：执行保存后操作

后台任务按步骤调用；同一次操作可能因重试再次调用。

```ts
execute(input: {
  readonly operationId: string;
  readonly record: FileContext;
  readonly publicPath: string;
  readonly url: string;
  readonly file: FileInput;
  readonly currentDisposition: PostSaveDisposition;
  readonly previousResults: readonly Readonly<PostSaveStepResult>[];
}, context: PostSaveContext): Promise<PostSaveResult>;
```

`PostSaveResult` 的字段均可省略，通知插件可以只返回 `{ details: { sent: true } }`：

| 字段           | 类型                                                                       | 核心行为                                             |
| -------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `disposition`  | `{ value: "pass" \| "block" \| "delete", mode?: "escalate" \| "replace" }` | 提出处置；省略表示不参与                             |
| `organization` | `OrganizationUpdate`                                                       | 修改本次图片的标签或集合                             |
| `details`      | `Config`                                                                   | 保存简要 JSON 对象并传给后续步骤，不放凭证或图片字节 |

`record` 包含文件 ID、时间、来源、归属及当前有效归类；`context.organization` 提供当前归属范围内的查找和创建服务，见[文件上下文与归类](../plugin-services.md#文件上下文与归类)。归类修改省略字段表示保留该项，空数组清空，非空数组设置完整目标 ID，每项最多 100 个。

`operationId` 可用于远端幂等处理；`publicPath` 含公开前缀、不含域名，`url` 在未配置域名时可能是相对路径。`currentDisposition` 是本次尝试的累计决策，初始为 `pass`，并非数据库文件状态。

`previousResults` 按执行顺序包含本次尝试已完成步骤的隔离快照。每项复用规范化后的结果，加上 `stepId`、`pluginId`、`pluginVersion` 和 Unix 毫秒时间 `completedAt`。有处置时记录明确的 `mode`。结果表示步骤当时接受的修改，文件详情中的关系才是当前归类。

<span id="扩展与约束"></span>

## 可选能力与约束

### 如何形成累计处置

省略 `mode` 或使用 `escalate` 时，按 `pass < block < delete` 累积；`replace` 明确覆盖此前累计决策，后续步骤仍可再次改变：

| 步骤 | 返回值                                                | 累计处置 |
| ---- | ----------------------------------------------------- | -------- |
| 审核 | `{ disposition: { value: "block" } }`                 | `block`  |
| 复核 | `{ disposition: { value: "pass", mode: "replace" } }` | `pass`   |
| 通知 | `{ details: { sent: true } }`                         | `pass`   |

`block/delete` 不终止后续步骤，后续步骤通过 `currentDisposition` 决定是否通知，通过 `previousResults` 读取前序识别摘要。`delete` 随后由后台清理副本，不表示远端图片已删除。

### 归类与失败提交

每一步完整结果有效后才同时接受归类、处置和摘要。同一步返回屏蔽意见和非法分类时，整个步骤失败，屏蔽意见也不参与累计。需要审核独立生效时，将审核与归类配置为两个步骤，让归类步骤读取前序 `details`。

本次执行成功或失败时，核心统一提交此前已接受的归类、处置、结果及任务状态。只写插件明确修改的归类字段；未改集合不会覆盖人工编辑的集合。人工与插件对同一字段的修改按提交顺序生效。已接受结果中的分类在提交前被删除时排除相应 ID；文件被其他操作置入删除流程后，不再写新归类或覆盖删除状态。

累计为 `block/delete` 时，失败任务不自动重试；为 `pass` 时，可重试错误按次数限制重试整条流水线。只有 `ready` 文件可重新执行，每次从数据库当前归类及空前序结果开始。屏蔽文件必须先由管理员解除屏蔽，重试不隐式放行；删除失败通过删除任务处理。

一次执行的结果总量上限为 64 KiB，包括步骤标识、处置、归类与摘要。只返回完成后续处理和解释结果所需的内容。

### 步骤间传值

`context.data` 用于本次流水线的临时 JSON，`previousResults` 用于保存后读取已完成步骤的接受结果，`currentDisposition` 用于读取每步执行前的累计处置。临时数据不跨请求或重试保存；持久运行数据见[状态服务](../plugin-services.md#密钥与运行状态)。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
