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

<<< ../../../examples/processor/src/index.ts#implementation

`process` 判断格式，通过宿主 Sharp 缩放，再写入本次输出。示例将输入读入内存，不放大小图。

大文件处理应评估内存或采用流式实现，并遵守宿主传入的 `limits` 和取消信号。

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，创建上传流水线，添加 **Example resize**。
2. 将固定宽度设为 `1280`，关联到一个上传配置，先不启用请求参数。
3. 上传宽于 1280 像素的静态 JPEG、PNG 或 WebP，打开不带处理参数的链接，确认宽度为 1280。

本例不放大小图；测试时不要同时配置访问缩放，避免混淆保存结果与访问结果。

## 接口行为

配置与实例声明见[插件基础](../plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](../plugin-services.md)。

### process：执行处理

宿主为流水线中的每个步骤调用一次此方法。固定配置从实例闭包读取。

```ts
process(
  input: UploadProcessInput,
  context: UploadProcessContext,
): Promise<UploadResult>;
```

#### 输入与上下文

| `input` 成员 | 类型 | 用法 |
| --- | --- | --- |
| `params` | `Parameters` | 已校验的请求参数，不含固定配置 |
| `file` | `FileInput` | 前序步骤接受的图片，通过 `metadata` 或 `openRead()` 读取 |
| `record` | `FileContext` | 当前文件的身份、归属和归类，见[文件上下文](../plugin-services.md#文件上下文与归类) |
| `limits` | `{ maxDimension: number; maxPixels: number }` | 单边像素数和总像素数上限 |
| `createOutput()` | `() => Promise<Output>` | 创建本次调用的替换输出 |

通过 `context.organization` 查找或创建分类，见[文件上下文与归类](../plugin-services.md#文件上下文与归类)。取消信号、日志等共用成员见[调用上下文](../plugin-services.md#调用上下文)。

管理员在步骤中启用 `width` 后，本次上传可通过 `params` 指定宽度；不传则使用固定配置。见 [配置与请求参数示例](../plugin-config.md#固定配置与请求参数)。

#### 返回值

```ts
type UploadResult =
  | { status: "pass"; organization?: OrganizationUpdate }
  | { status: "replace"; output: Output; organization?: OrganizationUpdate }
  | { status: "reject"; reason: string }
  | { status: "unsupported"; reason?: string };
```

| `status` | 效果 |
| --- | --- |
| `pass` | 保留当前图片，继续下一步 |
| `replace` | 校验输出并更新当前图片，继续下一步 |
| `reject` | 中止本次上传并报错 |
| `unsupported` | 由步骤策略决定跳过或中止 |

输出来自本次 `createOutput()`，写入完成后才能返回。输出接口见 [文件与输出](../plugin-services.md#文件与输出)。

后续步骤和路径插件读取已接受的图片与归类。

返回 `organization: { tagIds, collectionIds }` 设置完整目标关系；省略字段保留该项，空数组清空。每项最多 100 个 ID，仅可选择当前归属范围内的分类。核心完整校验图片输出及归类后才同时接受；无效结果不会部分更新。仅需归类时返回 `{ status: "pass", organization: { tagIds: [tag.id] } }`。

#### 失败行为

执行失败时抛出 [`PluginError`](../plugin-errors.md#pluginerror-字段)。仅在输入确实不适用时返回 `unsupported`。
