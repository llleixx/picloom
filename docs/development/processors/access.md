# 访问处理

访问处理按请求参数生成派生图片，不覆盖原图。下面通过 `?width=320` 获取缩略图；没有参数时返回原图，命中派生缓存时可跳过处理。

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

<<< ../../../examples/access/src/index.ts#implementation

`getFile()` 延迟读取原图；`output.write()` 完成后返回 `replace`。取消时销毁 Sharp 处理资源。

<span id="接入并验证"></span>

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，在全局访问流水线中添加 **Example thumbnail**，启用参数 `width`。
2. 测试时先只保留这个访问步骤，上传一张宽于 320 像素的静态 JPEG、PNG 或 WebP。
3. 打开带 `?width=320` 的链接，确认宽度为 320；去掉参数，确认仍是原尺寸。

## 接口行为

配置与实例声明见[插件基础](../plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](../plugin-services.md)。

### check：决定是否执行

核心对当前图片调用检查；只有返回 `applicable` 才调用本步骤的 `process`。

```ts
check(input: {
  params: Parameters;
  readonly metadata: Readonly<Metadata>;
  getFile(): Promise<FileInput>;
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
  readonly metadata: Readonly<Metadata>;
  getFile(): Promise<FileInput>;
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
| 拒绝     | `status: "reject"`、`reason: string`  | 中止本次访问并报错                 |

输出来自本次 `createOutput()`，写入完成后才能返回。输出接口见 [文件与输出](../plugin-services.md#文件与输出)。

输入沿用 `check` 的字段，并增加 `createOutput()`；上下文允许写入流水线临时数据。

<span id="扩展与约束"></span>

## 可选能力与约束

`getFile()` 必须等待完成，返回的文件仍通过 `openRead()` 读取，不保证有本地路径。输出只能写一次，并且只能返回本次调用创建的输出。

访问实例默认允许共享派生缓存，需要禁用时在运行对象中返回 `cacheable: false`。缓存命中可能跳过整个处理过程，不要依赖插件逐次记录访问或发送通知；浏览器/CDN 缓存还可能使请求根本不抵达 Picloom。

本例将输入读入内存，不放大小图。处理大图时需考虑解码内存，并传递取消信号，见 [错误、取消与并发](../plugin-errors.md)。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
