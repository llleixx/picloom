# 路径插件

## 想实现什么

希望上传后的图片按日期组织，例如 `/photos/2026/10/18/abc.jpg`。上传配置已经提供 `/photos/` 前缀，你只需写一个插件，生成后面的日期和文件名。

## 在哪里执行

```mermaid
flowchart LR
    A[上传处理后的图片] --> B[路径插件生成键]
    B --> C[核心保存路径关系]
    C --> D[存储插件写入内容]
```

## 谁负责什么

路径插件返回命名结果，不创建目录、不上传图片。Picloom 组合公开前缀、保存文件记录，并将存储键交给存储插件。

## 看一次调用

假设上传时间是 UTC 的 2026 年 10 月 18 日，文件 ID 是 `abc`，图片类型为 JPEG。核心调用 `generate`，示例返回：

```json
{ "logicalKey": "2026/10/18/abc.jpg" }
```

配合上传配置的 `/photos/`，最终公开路径就是 `/photos/2026/10/18/abc.jpg`。

## 定义与能力清单

默认导出 `Definition<"path">`：身份字段中设置 `kind: "path"`，在顶层声明配置描述。结构见 [插件基础](./plugin-start.md#代码默认导出什么)。

| 位置 | 成员 | 必需 | 作用 |
| --- | --- | --- | --- |
| 定义 | `configSchemaVersion`、`configSchema` | 是 | 配置结构版本和表单 |
| 定义 | `createInstance` | 是 | 返回 `PathPlugin` 运行对象 |
| 定义 | `validateConfig`、`migrateConfig`、`uiHints`、`translations` | 否 | [共用配置能力](./plugin-config.md#配置描述字段) |
| 运行对象 | `generate` | 是 | 生成相对键 |
| 运行对象 | `dispose` | 否 | [释放实例资源](./plugin-errors.md#dispose-释放实例) |

## generate：生成路径

每次需要为新文件生成路径时调用。签名如下：

```ts
generate(input: {
  fileId: string;
  uploadedAt: number;
  metadata: Metadata;
  originalName?: string;
}, context: Context): Promise<{ logicalKey: string; storageKey?: string }>;
```

| 参数 / 字段 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `input.fileId` | `string` | 否 | 文件 ID，可用于避免重名 |
| `input.uploadedAt` | `number` | 否 | 上传时间，Unix 毫秒时间戳 |
| `input.metadata` | `Metadata` | 否 | 当前图片元数据；[具体字段](./plugin-config.md#文件与输出)可能为空 |
| `input.originalName` | `string` | 是 | 原文件名，不能直接当作安全路径 |
| `context` | `Context` | 否 | [取消信号与日志](./plugin-config.md#调用上下文) |

| 返回字段 | 类型 | 必需 | 核心行为 |
| --- | --- | --- | --- |
| `logicalKey` | `string` | 是 | 与上传配置的公开前缀组成公开路径 |
| `storageKey` | `string` | 否 | 交给存储插件使用；省略时使用 `logicalKey` |

只返回命名结果，不创建文件。生成失败时抛出错误，本次上传不能继续。

## 最小实现

清单告诉 Picloom 插件身份和构建后的入口：

<<< ../../examples/path/plugin.json

入口先声明配置，再通过 `createInstance` 返回 `generate` 方法。本例不需要配置，因此 Schema 是空对象：

<<< ../../examples/path/index.ts

## 接入并验证

按 [构建步骤](./plugin-start.md#准备并构建示例) 生成示例包后：

1. 以 Owner 登录，在插件页面上传 `path.zip`，确认信任并安装。
2. 新建上传配置，选择 **Example date path**，关联已有存储组，公开前缀设为 `/photos/`。
3. 上传一张图片，确认返回路径包含当天的 UTC 日期和文件 ID。

## 扩展与约束

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
