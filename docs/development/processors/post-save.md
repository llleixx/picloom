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

`execute` 读取元数据，返回 `pass` 或 `block`，并用 `details` 记录宽度和阈值。

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
  operationId: string;
  fileId: string;
  publicPath: string;
  url: string;
  file: FileInput;
  readonly currentStatus: PostSaveStatus;
  readonly previousResults: readonly Readonly<PostSaveStepResult>[];
}, context: PipelineContext): Promise<PostSaveResult>;
```

`PostSaveStatus` 为 `"pass" | "block" | "delete"`。返回 `PostSaveResult`：

| 字段             | 类型             | 必需 | 核心行为                                               |
| ---------------- | ---------------- | ---- | ------------------------------------------------------ |
| `status`         | `PostSaveStatus` | 是   | 本步骤意见：放行、屏蔽或删除，参与累计                 |
| `details`        | `Config`         | 否   | 保存简要 JSON 对象，并传给后续步骤；不放凭证或图片字节 |
| `overrideStatus` | `PostSaveStatus` | 否   | 强制替换本步骤后的累计状态；后续步骤仍可改变           |

`previousResults` 每项为 `PostSaveStepResult`，包含上述原始返回字段，并增加：

| 字段            | 类型     | 必需 | 含义                      |
| --------------- | -------- | ---- | ------------------------- |
| `stepId`        | `string` | 是   | 前序步骤 ID               |
| `pluginId`      | `string` | 是   | 执行该步骤的插件 ID       |
| `pluginVersion` | `string` | 是   | 插件版本                  |
| `completedAt`   | `number` | 是   | 完成时间，Unix 毫秒时间戳 |

返回 `block/delete` 不终止后续步骤；核心在本次执行结束时应用累计处置。组合规则见下文。

`operationId` 可用于远端幂等处理；`publicPath` 含公开前缀、不含域名，`url` 在未配置域名时可能是相对路径。`currentStatus` 初始为 `pass`，`previousResults` 只含当前尝试已完成步骤的快照。

<span id="扩展与约束"></span>

## 可选能力与约束

先理解一个步骤的结果，再组合多个步骤。下面区分每一步的原始意见与核心最终采用的累计状态。

### 后续步骤能读到什么

继续上面的宽度检查示例。它返回 `block` 后，下一个步骤收到的输入片段如下：

```json
{
  "currentStatus": "block",
  "previousResults": [
    {
      "stepId": "step-width-review",
      "pluginId": "example.width-review",
      "pluginVersion": "1.0.0",
      "completedAt": 1792310400000,
      "status": "block",
      "details": {
        "width": 2400,
        "maxWidth": 1280
      }
    }
  ]
}
```

`previousResults` 按执行顺序排列，只包含本次尝试中已完成的步骤，不包含当前步骤。没有详情的步骤也会记录，只是省略 `details`。`completedAt` 使用 Unix 毫秒时间戳。

这是独立快照，修改它不会改变核心记录。完整实现可参考 扩展仓库中的腾讯审核（`picloom-extensions/plugins/tencent-moderation`） 和 [Telegram 通知](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/index.ts)：前者给出处置，后者根据当前累计状态决定是否通知。

### 如何形成累计处置

初始状态为 `pass`，默认按 `delete > block > pass` 累计。可选的 `overrideStatus` 强制替换当前累计状态，后续步骤仍可再次改变它：

| 步骤 | 返回值                                       | 累计状态 |
| ---- | -------------------------------------------- | -------- |
| 审核 | `{ status: "block" }`                        | `block`  |
| 复核 | `{ status: "pass", overrideStatus: "pass" }` | `pass`   |
| 通知 | `{ status: "pass" }`                         | `pass`   |

通知插件正常完成时返回 `pass` 即可；不返回 `overrideStatus`，就不会撤销之前的屏蔽或删除意见。

`block/delete` 不终止后续步骤。核心在本次执行结束时应用累计处置，`delete` 随后由后台清理副本，不表示远端图片已删除。

### 后续失败怎么办

后续步骤抛错时，已完成步骤的结果和处置仍会保留，非法返回值不参与累计。累计为 `block/delete` 时，失败任务不再自动重试；为 `pass` 时，可重试错误按限制重试整条流水线，新尝试的前序结果从空列表开始。

一次执行的结果记录总量上限为 64 KiB，包括步骤标识和详情。只返回足够解释处理结果的摘要。

### 步骤间传值

| 机制              | 用途                                                                 | 生命周期                                   |
| ----------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `context.data`    | 使用命名空间传递本次执行的临时 JSON 数据；`check` 只读，处理方法可写 | 同一次流水线执行，不跨请求或重试保存       |
| `previousResults` | 保存后阶段读取前序步骤的原始结果，包括可选 `overrideStatus`          | 当前尝试已完成的步骤；核心另行保存结果记录 |
| `currentStatus`   | 保存后阶段读取当前累计处置                                           | 每步执行前由核心计算                       |

`context.data` 的命名空间应避免与其他插件冲突，例如使用插件 ID；总量限制为 256 KiB，读取返回副本，修改后需调用 `set` 才会生效。需要跨调用持久保存的数据应使用 [状态服务](../plugin-services.md#密钥与运行状态)。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
