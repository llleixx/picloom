# 路径插件

路径插件在上传处理之后生成相对路径。下面按 UTC 日期和文件 ID 命名，例如 `2026/10/18/abc.jpg`；Picloom 添加公开前缀并交给存储插件，不需要插件创建目录。

## 最小实现

按[快速开始](./plugin-tooling.md)创建项目，将 `plugin.json.kind` 设为 `path`，保留自己的 ID 和版本。将 `src/index.ts` 替换为以下外层代码，再用下一段实现替换注释行：

```ts
import { PluginError, type Definition } from "@picloom/plugin-sdk";
import manifest from "../plugin.json";

const { kind, apiVersion } = manifest;
if (kind !== "path" || apiVersion !== 1)
  throw new Error("Expected path plugin API 1");

export default {
  id: manifest.id,
  version: manifest.version,
  kind,
  apiVersion,
  // 将下一段实现放在这里
} satisfies Definition<"path">;
```

<<< ../../examples/path/src/index.ts#implementation

`generate` 返回 `logicalKey`；未提供 `storageKey` 时，存储使用同一相对键。

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 以 Owner 登录，在插件页面上传生成的 ZIP，确认信任并安装。
2. 新建上传配置，选择 **Example date path**，关联已有存储组，公开前缀设为 `/photos/`。
3. 上传一张图片，确认返回路径包含当天的 UTC 日期和文件 ID。

## 接口行为

配置与实例声明见[插件基础](./plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](./plugin-services.md)。

### generate：生成路径

每次需要为新文件生成路径时调用。签名如下：

```ts
generate(input: {
  readonly record: FileContext;
  readonly metadata: Readonly<Metadata>;
  readonly originalName?: string;
}, context: Context): Promise<{ logicalKey: string; storageKey?: string }>;
```

#### 输入与上下文

| `input` 成员 | 类型 | 用法 |
| --- | --- | --- |
| `record` | `FileContext` | 文件 ID、来源、归属和上传处理后的归类。`createdAt` 为 Unix 毫秒时间戳。见[文件上下文](./plugin-services.md#文件上下文与归类) |
| `metadata` | `Readonly<Metadata>` | 当前图片的[元数据](./plugin-services.md#文件与输出)，尺寸等字段可能未知 |
| `originalName` | `string`（可选） | 可选的原文件名。用于命名时，先转换为安全的路径段 |

`context` 提供取消信号、调用标识和日志，见[调用上下文](./plugin-services.md#调用上下文)。

#### 返回值

| 返回字段     | 类型     | 必需 | 核心行为                                  |
| ------------ | -------- | ---- | ----------------------------------------- |
| `logicalKey` | `string` | 是   | 与上传配置的公开前缀组成公开路径          |
| `storageKey` | `string` | 否   | 交给存储插件使用；省略时使用 `logicalKey` |

**路径示例**

默认只返回 `logicalKey`，存储也使用相同相对键。需要不同命名时，再返回 `storageKey`：

```json
{
  "logicalKey": "2026/10/18/abc.jpg",
  "storageKey": "objects/abc.jpg"
}
```

此时公开路径仍是 `/photos/2026/10/18/abc.jpg`，存储插件使用 `objects/abc.jpg`。插件返回原始相对键，不添加域名、公开前缀或提前进行 URL 编码。

**路径规则**

两个键都必须是有效相对路径：不能以 `/` 开头，不能有空路径段、`.`、`..`、反斜杠、控制字符或 `?`、`#`、`:`。长度最多 2048 个字符。SDK 的 `logicalKey()` 可用于校验。

不同文件应生成不同路径，通常保留 `record.id` 即可。核心按完整公开路径检查唯一性，但不会替插件自动改名；也不要让不同文件共享同一个存储对象键。

修改配置或升级路径插件只影响后续上传，不会重命名已有文件或修改旧链接。

#### 失败行为

生成失败时抛出 [`PluginError`](./plugin-errors.md#pluginerror-字段)，本次上传中止。
