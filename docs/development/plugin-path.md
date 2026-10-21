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

<<< ../../examples/path/index.ts#implementation

`generate` 返回 `logicalKey`；未提供 `storageKey` 时，存储使用同一相对键。

<span id="接入并验证"></span>

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
  fileId: string;
  uploadedAt: number;
  metadata: Metadata;
  originalName?: string;
}, context: Context): Promise<{ logicalKey: string; storageKey?: string }>;
```

| 返回字段     | 类型     | 必需 | 核心行为                                  |
| ------------ | -------- | ---- | ----------------------------------------- |
| `logicalKey` | `string` | 是   | 与上传配置的公开前缀组成公开路径          |
| `storageKey` | `string` | 否   | 交给存储插件使用；省略时使用 `logicalKey` |

只返回命名结果，不创建文件。生成失败时抛出错误，本次上传不能继续。

`uploadedAt` 是 Unix 毫秒时间戳；元数据可能未知。原文件名不可直接用作安全路径，通常保留 `fileId` 避免重名。

<span id="扩展与约束"></span>

## 可选能力与约束

### 公开路径与存储键分开

默认只返回 `logicalKey`，存储也使用相同相对键。需要不同命名时，再返回 `storageKey`：

```json
{
  "logicalKey": "2026/10/18/abc.jpg",
  "storageKey": "objects/abc.jpg"
}
```

此时公开路径仍是 `/photos/2026/10/18/abc.jpg`，存储插件使用 `objects/abc.jpg`。插件返回原始相对键，不添加域名、公开前缀或提前进行 URL 编码。

### 路径规则

两个键都必须是有效相对路径：不能以 `/` 开头，不能有空路径段、`.`、`..`、反斜杠、控制字符或 `?`、`#`、`:`。长度最多 2048 个字符。SDK 的 `logicalKey()` 可用于校验。

不同文件应生成不同路径，通常保留 `fileId` 即可。核心按完整公开路径检查唯一性，但不会替插件自动改名；也不要让不同文件共享同一个存储对象键。

修改配置或升级路径插件只影响后续上传，不会重命名已有文件或修改旧链接。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
