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

本例将输入读入内存，不放大小图。处理大图时需考虑解码内存，并传递取消信号，见 [错误、取消与并发](../plugin-errors.md)。

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，在全局访问流水线中添加 **Example thumbnail**，启用参数 `width`。
2. 测试时先只保留这个访问步骤，上传一张宽于 320 像素的静态 JPEG、PNG 或 WebP。
3. 打开带 `?width=320` 的链接，确认宽度为 320；去掉参数，确认仍是原尺寸。

## 接口行为

配置与实例声明见[插件基础](../plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](../plugin-services.md)。

### process：执行处理

宿主为流水线中的每个步骤调用一次此方法。固定配置从实例闭包读取。

```ts
process(
  input: AccessProcessorInput,
  context: PipelineContext,
): Promise<ImageProcessResult>;
```

#### 输入与上下文

| `input` 成员 | 类型 | 用法 |
| --- | --- | --- |
| `params` | `Parameters` | 已校验的请求参数，不含固定配置 |
| `metadata` | `Readonly<Metadata>` | 当前图片元数据，可先判断是否需要读取内容 |
| `getFile()` | `() => Promise<FileInput>` | 按需取得当前图片，再调用 `openRead()` 读取内容 |
| `limits` | `{ maxDimension: number; maxPixels: number }` | 单边像素数和总像素数上限 |
| `createOutput()` | `() => Promise<Output>` | 创建本次调用的替换输出 |

通过 `context.data` 与同一流水线的其他步骤共享临时 JSON。取消信号、日志等共用成员见[调用上下文](../plugin-services.md#调用上下文)。

#### 返回值

```ts
type ImageProcessResult =
  | { status: "pass" }
  | { status: "replace"; output: Output }
  | { status: "reject"; reason: string }
  | { status: "unsupported"; reason?: string };
```

| `status` | 效果 |
| --- | --- |
| `pass` | 保留当前图片，继续下一步 |
| `replace` | 校验输出并更新当前图片，继续下一步 |
| `reject` | 中止本次访问并报错 |
| `unsupported` | 由步骤策略决定跳过或中止 |

输出来自本次 `createOutput()`，写入完成后才能返回。输出接口见 [文件与输出](../plugin-services.md#文件与输出)。

#### 失败行为

执行失败时抛出 [`PluginError`](../plugin-errors.md#pluginerror-字段)。仅在输入确实不适用时返回 `unsupported`。

## 可选能力与约束

访问实例默认允许共享派生缓存，需要禁用时在运行对象中返回 `cacheable: false`。缓存命中可能跳过整个处理过程，不要依赖插件逐次记录访问或发送通知；浏览器/CDN 缓存还可能使请求根本不抵达 Picloom。
