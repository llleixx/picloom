# 保存后处理

## 想实现什么

图片保存后检查宽度，超过 1280 像素就屏蔽，否则放行。这个简单规则用于演示审核流程，不需要连接外部审核服务。

## 在哪里执行

```mermaid
flowchart LR
    A[图片保存成功] --> B[后台执行保存后流水线]
    B --> C[各步骤返回处理意见]
    C --> D[核心应用累计处置]
```

保存后处理是后台工作。上传完成不表示审核已经完成，也不能保证审核之前图片从未被访问。

## 谁负责什么

插件检查文件并返回意见，不直接修改数据库或删除存储对象。Picloom 累计各步骤的意见，更新文件状态，需要删除时再安排副本清理。

通知也是保存后处理的一种：执行外部操作后返回 `pass`，不必改变已有审核意见。

## 看一次调用

假设保存的图片宽 2400 像素，固定配置 `maxWidth` 为 1280。核心调用 `execute`，插件读取元数据后返回：

```json
{
  "status": "block",
  "details": { "width": 2400, "maxWidth": 1280 }
}
```

只有这一个步骤时，核心在本次执行结束后屏蔽图片。文件仍保留在存储中，但公开访问被阻止。宽度未超限则返回 `pass`。

## 定义与能力清单

定义设置 `kind: "processor"`，配置描述放在 `stages.post_save` 中。

| 位置     | 成员                                                                                 | 必需 | 作用                                                                   |
| -------- | ------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| 阶段描述 | `configSchemaVersion`、`createInstance` | 是   | 创建 `PostSavePlugin`，见 [共用协议](../plugin-config.md#配置描述字段) |
| 阶段描述 | `configSchema` | 否 | 自定义配置表单；省略时只接受空配置 `{}` |
| 阶段描述 | `validateConfig`、`migrateConfig`                                                    | 否   | 配置校验和升级                                                   |
| 运行对象 | `execute`                                                                            | 是   | 执行操作并返回处理意见                                                 |
| 运行对象 | `dispose`                                                                            | 否   | [释放实例资源](../plugin-errors.md#dispose-释放实例)                   |

此阶段没有 `paramsSchema`、`check/process` 或替换图片的输出接口。

## execute：执行保存后操作

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

| 参数 / 字段             | 类型              | 可选 | 含义                                                                        |
| ----------------------- | ----------------- | ---- | --------------------------------------------------------------------------- |
| `input.operationId`     | `string`          | 否   | 本次步骤操作的标识，可用于幂等处理                                          |
| `input.fileId`          | `string`          | 否   | Picloom 文件 ID                                                             |
| `input.publicPath`      | `string`          | 否   | 完整公开路径，含前缀，不含域名                                              |
| `input.url`             | `string`          | 否   | 图片链接；未配置站点或图片域名时可能是相对路径                              |
| `input.file`            | `FileInput`       | 否   | 保存后图片的[元数据与可读取内容](../plugin-config.md#文件与输出)            |
| `input.currentStatus`   | `PostSaveStatus`  | 否   | 当前步骤前的累计处置；初始为 `pass`                                         |
| `input.previousResults` | 只读结果数组      | 否   | 本次尝试中成功完成的前序步骤快照；第一步为空数组                            |
| `context`               | `PipelineContext` | 否   | 取消、日志和本次流水线数据，见 [调用上下文](../plugin-config.md#调用上下文) |

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

返回 `block/delete` 不终止后续步骤；核心在本次执行结束时应用累计处置。下面的完整示例先演示单步，组合规则放在扩展部分。

## 最小实现

先按[快速开始](../plugin-tooling.md)创建独立项目。下面展示仓库中的完整示例；
复制到 `src/index.ts` 时，按[使用教程示例](../plugin-tooling.md#使用教程示例)调整 SDK 导入、清单身份和插件类型。

实例保存宽度阈值，`execute` 只读取文件元数据，返回处理结果：

<<< ../../../examples/post-save/index.ts

## 接入并验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
下面的 **Example …** 是示例名，实际应选择入口 `messages` 中设置、按当前界面语言显示的名称：

1. 安装 生成的 ZIP，创建保存后流水线，添加 **Example width review**，将 `maxWidth` 设为 `1280`。
2. 关联到上传配置。测试时不要启用上传缩放，否则审核的是缩放后的图片。
3. 分别上传宽度小于和大于 1280 的图片，等待后台操作完成。
4. 在图片详情查看结果：前者可访问，后者被屏蔽，详情记录实际宽度和阈值。

## 扩展与约束

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

这是独立快照，修改它不会改变核心记录。完整实现可参考 [腾讯审核](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/tencent-moderation/index.ts) 和 [Telegram 通知](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/telegram-notification/index.ts)：前者给出处置，后者根据当前累计状态决定是否通知。

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

`context.data` 的命名空间应避免与其他插件冲突，例如使用插件 ID；总量限制为 256 KiB，读取返回副本，修改后需调用 `set` 才会生效。需要跨调用持久保存的数据应使用 [状态服务](../plugin-config.md#密钥与运行状态)。
