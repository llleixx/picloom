# 上传处理

上传处理在图片保存前运行。下面把超过 1280 像素宽的静态图片缩小，后续步骤及存储接收到缩小后的内容。

## 最小实现

按[快速开始](../plugin-tooling.md)创建项目，将 `plugin.json.kind` 设为 `processor`，保留自己的 ID 和版本。将 `src/index.ts` 替换为以下外层代码，再用下一段实现替换注释行：

```ts
import { Readable } from "node:stream";
import {
  PluginError,
  withAbortSignal,
  type Definition,
} from "@picloom/plugin-sdk";
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

<<< ../../../examples/processor/index.ts#implementation

`check` 判断格式，`process` 通过宿主 Sharp 缩放，再写入本次输出。示例将输入读入内存，不放大小图。

<span id="接入并验证"></span>

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，创建上传流水线，添加 **Example resize**。
2. 将固定宽度设为 `1280`，关联到一个上传配置，先不启用请求参数。
3. 上传宽于 1280 像素的静态 JPEG、PNG 或 WebP，打开不带处理参数的链接，确认宽度为 1280。

本例不放大小图；测试时不要同时配置访问缩放，避免混淆保存结果与访问结果。

## 接口行为

配置与实例声明见[插件基础](../plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](../plugin-services.md)。

### check：决定是否执行

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

返回对象必须含 `status`，可选 `reason: string` 说明原因：

| `status`      | 核心行为                                             |
| ------------- | ---------------------------------------------------- |
| `applicable`  | 调用本步骤的 `process`                               |
| `noop`        | 不处理，直接进入下一步                               |
| `unsupported` | 根据步骤配置跳过或中止；中止时使用 `reason` 说明原因 |

检查阶段不能创建输出，也不能写入 `context.data`。执行异常应抛错，不要用 `unsupported` 隐藏失败。

`limits.maxDimension` 是最大单边像素数，`maxPixels` 是最大像素总数。请求参数已经筛选并校验，不自动合并固定配置。

### process：执行处理

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

| 返回形式 | 必需字段                              | 核心行为                           |
| -------- | ------------------------------------- | ---------------------------------- |
| 保留     | `status: "pass"`                      | 当前图片不变，继续下一步           |
| 替换     | `status: "replace"`、`output: Output` | 校验输出并更新当前图片，继续下一步 |
| 拒绝     | `status: "reject"`、`reason: string`  | 中止本次上传并报错                 |

输出来自本次 `createOutput()`，写入完成后才能返回。输出接口见 [文件与输出](../plugin-services.md#文件与输出)。

输入沿用 `check` 的字段，并增加 `createOutput()`；上下文允许写入流水线临时数据。

<span id="扩展与约束"></span>

## 可选能力与约束

管理员在步骤中启用 `width` 后，本次上传可通过 `params` 指定宽度；不传则使用固定配置。见 [配置与请求参数示例](../plugin-config.md#固定配置与请求参数)。

输出只能写一次，必须是本次调用通过 `createOutput()` 创建的对象。核心检查图片和尺寸后才接受替换。`check` 不提供输出创建能力，它的 `context.data` 也只读。

示例将输入读入内存，便于理解。大文件处理应评估内存或采用流式实现，并遵守宿主传入的 `limits` 和取消信号。网络异常应抛错，不要返回 `unsupported` 隐藏失败。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
