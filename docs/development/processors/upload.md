# 上传处理

## 想实现什么

希望上传的图片最多宽 1280 像素，较大的图片缩小后再保存。这样以后读取原图时，取得的就是缩小后的内容。

## 在哪里执行

```mermaid
flowchart LR
    A[收到图片] --> B[上传处理]
    B --> C[路径插件命名]
    C --> D[存储插件保存]
```

## 谁负责什么

插件决定是否处理，并输出新图片。Picloom 管理输入、临时空间、输出校验及后续保存；插件不直接写入存储源，也不需要创建文件记录。

多个步骤按顺序执行，下一步收到前一步替换后的图片。

## 看一次调用

假设输入是一张宽 2400 像素的静态 PNG，固定宽度为 1280：

1. 核心调用 `check`；插件确认支持该格式，返回 `applicable`。
2. 核心调用 `process`；插件读取输入，缩小并写入宿主提供的输出。
3. 插件返回 `replace` 和输出，核心重新识别图片，再将宽 1280 像素的结果交给下一步。

## 定义与能力清单

定义设置 `kind: "processor"`，将以下阶段描述放在 `stages.upload` 中，而不是插件顶层。

| 位置 | 成员 | 必需 | 作用 |
| --- | --- | --- | --- |
| 阶段描述 | `configSchemaVersion`、`configSchema`、`createInstance` | 是 | 创建 `ProcessorPlugin`，见 [共用协议](../plugin-config.md#配置描述字段) |
| 阶段描述 | `paramsSchema` | 否 | 声明可接受的本次请求参数；还需管理员逐项启用 |
| 阶段描述 | `validateConfig`、`migrateConfig`、`uiHints`、`translations` | 否 | 配置校验、升级和展示 |
| 运行对象 | `check`、`process` | 是 | 检查适用性，执行处理 |
| 运行对象 | `dispose` | 否 | [释放实例资源](../plugin-errors.md#dispose-释放实例) |

`Parameters` 是 `Record<string, string | number | boolean>`，没有本次参数时为空对象。文件及元数据的完整字段见 [文件与输出](../plugin-config.md#文件与输出)。

## check：决定是否执行

核心对当前图片调用检查；只有返回 `applicable` 才调用本步骤的 `process`。

```ts
check(input: {
  params: Parameters;
  file: FileInput;
  limits: { maxDimension: number; maxPixels: number };
}, context: CheckContext): Promise<{
  status: "applicable" | "noop" | "unsupported";
  reason?: string;
}>;
```

| 参数 / 字段 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `input.params` | `Parameters` | 否 | 已筛选并校验的请求参数，不自动合并固定配置 |
| `input.file` | `FileInput` | 否 | 当前图片的元数据与可读取内容 |
| `input.limits.maxDimension` | `number` | 否 | 最大单边尺寸，像素 |
| `input.limits.maxPixels` | `number` | 否 | 最大像素总数 |
| `context` | `CheckContext` | 否 | 取消、日志及只读 `data.get`，见 [调用上下文](../plugin-config.md#调用上下文) |

返回对象必须含 `status`，可选 `reason: string` 说明原因：

| `status` | 核心行为 |
| --- | --- |
| `applicable` | 调用本步骤的 `process` |
| `noop` | 不处理，直接进入下一步 |
| `unsupported` | 根据步骤配置跳过或中止；中止时使用 `reason` 说明原因 |

检查阶段不能创建输出，也不能写入 `context.data`。执行异常应抛错，不要用 `unsupported` 隐藏失败。

## process：执行处理

检查通过后调用，固定配置通过实例闭包使用，本次参数来自 `input.params`。

```ts
process(input: {
  params: Parameters;
  file: FileInput;
  limits: { maxDimension: number; maxPixels: number };
  createOutput(): Promise<Output>;
}, context: PipelineContext): Promise<
  | { status: "pass" }
  | { status: "replace"; output: Output }
  | { status: "reject"; reason: string }
>;
```

| 参数 / 字段 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `input.params` | `Parameters` | 否 | 本次请求参数 |
| `input.file` | `FileInput` | 否 | 当前图片的元数据与可读取内容 |
| `input.limits.maxDimension` | `number` | 否 | 最大单边尺寸，像素 |
| `input.limits.maxPixels` | `number` | 否 | 最大像素总数 |
| `input.createOutput()` | `() => Promise<Output>` | 否 | 无参数，创建本次处理的输出对象 |
| `context` | `PipelineContext` | 否 | 取消、日志及可读写的 `data`，见 [调用上下文](../plugin-config.md#调用上下文) |

| 返回形式 | 必需字段 | 核心行为 |
| --- | --- | --- |
| 保留 | `status: "pass"` | 当前图片不变，继续下一步 |
| 替换 | `status: "replace"`、`output: Output` | 校验输出并更新当前图片，继续下一步 |
| 拒绝 | `status: "reject"`、`reason: string` | 中止本次上传并报错 |

输出来自本次 `createOutput()`，写入完成后才能返回。输出接口见 [文件与输出](../plugin-config.md#文件与输出)。

## 最小实现

`configSchema` 定义长期宽度配置；`createInstance` 返回 `check/process`。先看默认配置的处理过程，示例中的可选 `params.width` 在后面说明。

<<< ../../../examples/processor/index.ts

`file.openRead()` 提供输入流；`services.images.sharp` 是宿主提供的图片处理库。`createOutput()` 创建计入临时缓存的输出，写入完成后才能返回 `replace`。

## 接入并验证

按 [构建步骤](../plugin-start.md#准备并构建示例) 生成示例包后：

1. 安装 `processor.zip`，创建上传流水线，添加 **Example resize**。
2. 将固定宽度设为 `1280`，关联到一个上传配置，先不启用请求参数。
3. 上传宽于 1280 像素的静态 JPEG、PNG 或 WebP，打开不带处理参数的链接，确认宽度为 1280。

本例不放大小图；测试时不要同时配置访问缩放，避免混淆保存结果与访问结果。

## 扩展与约束

管理员在步骤中启用 `width` 后，本次上传可通过 `params` 指定宽度；不传则使用固定配置。见 [配置与请求参数示例](../plugin-config.md#固定配置与请求参数)。

输出只能写一次，必须是本次调用通过 `createOutput()` 创建的对象。核心检查图片和尺寸后才接受替换。`check` 不提供输出创建能力，它的 `context.data` 也只读。

示例将输入读入内存，便于理解。大文件处理应评估内存或采用流式实现，并遵守宿主传入的 `limits` 和取消信号。网络异常应抛错，不要返回 `unsupported` 隐藏失败。
