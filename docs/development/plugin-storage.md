# 存储插件

存储插件接收存储键和图片流，实现写入、读取与删除。下面使用本地目录；Picloom 负责公开路径、文件记录、副本及任务。

## 最小实现

按[快速开始](./plugin-tooling.md)创建项目，将 `plugin.json.kind` 设为 `storage`，保留自己的 ID 和版本。将 `src/index.ts` 替换为以下外层代码，再用下一段实现替换注释行：

```ts
import { mkdir, link } from "node:fs/promises";
import { resolve } from "node:path";
import {
  safePath,
  writeStream,
  remove,
  PluginError,
  type Definition,
} from "@picloom/plugin-sdk";
import manifest from "../plugin.json";

const { kind, apiVersion } = manifest;
if (kind !== "storage" || apiVersion !== 1)
  throw new Error("Expected storage plugin API 1");

export default {
  id: manifest.id,
  version: manifest.version,
  kind,
  apiVersion,
  // 将下一段实现放在这里
} satisfies Definition<"storage">;
```

<<< ../../examples/storage/src/index.ts#implementation

`safePath` 校验路径；临时文件和硬链接用于发布完整内容且不覆盖已有文件。写入完成后才返回。

<span id="接入并验证"></span>

## 安装与验证

在独立项目中运行 `bun run build`，使用生成的 `dist/<插件ID>-<版本>.zip`。
后台选择示例字典中的名称（随界面语言显示），或你自己修改后的名称：

1. 安装生成的 ZIP，创建 **Example local storage** 存储源，根目录填 `./example-images`。
2. 创建存储组并加入该存储源，创建上传配置并关联此组。
3. 上传图片，打开公开链接，再删除图片，确认对应文件被清理。

相对目录以应用数据目录为基准。默认 Docker 布局中，本例位于宿主机 `./data/app/example-images`。

## 接口行为

配置与实例声明见[插件基础](./plugin-start.md#配置描述字段)，文件和上下文见[宿主服务](./plugin-services.md)。

| 名称          | 含义                                                 |
| ------------- | ---------------------------------------------------- |
| `storageKey`  | 路径插件给出的相对存储键                             |
| `file`        | 文件输入，通过 `openRead()` 获取流，不保证有本地路径 |
| `locator`     | 插件返回的对象定位信息；核心保存并原样传给后续调用   |
| `operationId` | 写入或删除操作的标识，可用于识别重复调用             |

本地示例通过 `locator` 保存确认写入的路径。远端服务返回对象 ID 时，可用 `{ locator: { objectId: "remote-123" } }` 保存；也允许字符串定位信息，不要放入凭证。

### write：写入图片

核心保存副本时调用，各副本地位相同。完成后才可返回，不能遗留未等待的写入。

```ts
write(input: {
  operationId: string;
  fileId: string;
  storageKey: string;
  file: FileInput;
}, context: Context): Promise<{ locator?: Locator }>;
```

返回对象中的 `locator?: Locator` 是可选定位信息，省略时核心按 `null` 保存。只能在确认写入成功后返回；失败时通过 [PluginError](./plugin-errors.md#pluginerror-的三个字段) 表达原因及是否允许重试。

### read：读取图片

公开访问或图片处理需要内容时调用。

```ts
read(input: {
  storageKey: string;
  locator: Locator;
  mode: "auto" | "stream";
}, context: Context): Promise<ReadResult>;
```

`ReadResult` 为以下二选一，不能混合返回：

| 返回形式 | 字段        | 类型                         | 必需 | 核心行为                                         |
| -------- | ----------- | ---------------------------- | ---- | ------------------------------------------------ |
| 流       | `type`      | `"stream"`                   | 是   | 读取或转发内容                                   |
| 流       | `stream`    | `ReadableStream<Uint8Array>` | 是   | 图片内容流                                       |
| 流       | `mimeType`  | `string`                     | 否   | 内容的 MIME 类型                                 |
| 流       | `byteSize`  | `number`                     | 否   | 内容大小，字节                                   |
| 跳转     | `type`      | `"redirect"`                 | 是   | 返回重定向                                       |
| 跳转     | `url`       | `string`                     | 是   | 可访问的 HTTP(S) URL                             |
| 跳转     | `expiresAt` | `number`                     | 否   | URL 过期的 Unix 毫秒时间戳，用于限制响应缓存时间 |

图片处理需要实际内容，不能在 `mode: "stream"` 时仍返回签名链接。返回流后，消费可能尚未结束；应在流结束、出错或取消时释放它持有的连接，而不是在返回时提前关闭。

`mode: "auto"` 接受流或跳转；`mode: "stream"` 必须返回流。

### delete：删除对象

核心清理副本时调用。

```ts
delete(input: {
  operationId: string;
  storageKey: string;
  locator: Locator;
}, context: Context): Promise<void>;
```

成功无数据返回，失败抛错。目标已不存在通常可视为成功，但认证失败或查询超时不能当作“不存在”。只删除指定对象，不删除整个存储根目录。不支持删除或缺少必要定位时抛出错误，不可空返回成功；副本会进入删除失败，供用户重试或人工终结。

SDK 允许省略 `locator`，各插件仍须保证删除目标可靠。本地、S3、WebDAV 和 OpenList 在写入成功或扫描导入时返回明确定位；删除缺少已保存定位的副本时会失败，不通过 `storageKey` 猜测目标，以免删除发生路径冲突的其他对象。

<span id="扩展与约束"></span>

## 可选能力与约束
### listFiles：扫描导入（可选）

管理员导入存储源中的已有图片时，核心逐页调用此方法。

```ts
listFiles(input: {
  scope?: string;
  cursor?: string;
  limit: number;
}, context: Context): Promise<{
  items: Array<{
    storageKey: string;
    locator?: Locator;
    byteSize?: number;
    mimeType?: string;
  }>;
  nextCursor: string | null;
}>;
```

| 输入字段 | 类型     | 可选 | 含义                                     |
| -------- | -------- | ---- | ---------------------------------------- |
| `scope`  | `string` | 是   | 当前存储源内的扫描范围；不传时扫描整个源 |
| `cursor` | `string` | 是   | 上一页返回的游标；第一页不传             |
| `limit`  | `number` | 否   | 本页条数限制                             |

| 返回字段             | 类型             | 必需 | 含义                               |
| -------------------- | ---------------- | ---- | ---------------------------------- |
| `items`              | 数组             | 是   | 本页文件；没有文件时为空数组       |
| `items[].storageKey` | `string`         | 是   | 相对于存储源的文件键，不是公开 URL |
| `items[].locator`    | `Locator`        | 否   | 后续读取、删除所需的定位信息       |
| `items[].byteSize`   | `number`         | 否   | 字节大小                           |
| `items[].mimeType`   | `string`         | 否   | MIME 类型                          |
| `nextCursor`         | `string \| null` | 是   | 下一页游标；结束必须返回 `null`    |

扫描条目的定位会随副本保存。路径型存储应显式返回定位，供后续安全删除。游标由插件定义，核心原样传回。`scope` 只缩小扫描范围，不改变存储根目录，也不应从返回的键中剥离该范围前缀。导入选项 `stripDirectories` 由核心用于生成逻辑路径，默认 `0`；不传给插件，不修改 `storageKey` 或 `locator`。

### 本地目录声明（可选）

在定义顶层声明 `localDirectory: { configPath: "/root" }`。`configPath` 是必需的字符串 JSON Pointer，指向 Schema 中不可变、非敏感的字符串字段；不是目录本身。

用户填写 `./example-images` 时，宿主以应用数据目录为基准解析并保存绝对路径，插件收到的配置已完成解析。声明同时供容量统计和备份识别；不要让核心依靠插件 ID 猜测目录。

每次写入重试直接调用 `write`，沿用原 `operationId`，可能创建重复远端对象。重复写入不能覆盖其他文件；插件可利用远端幂等键减少重复。核心只管理已保存的定位，不枚举或补偿历史重复对象。接入远端服务时遵守 [错误与重试规则](./plugin-errors.md)。

<span id="想实现什么"></span><span id="在哪里执行"></span><span id="谁负责什么"></span><span id="看一次调用"></span><span id="定义与能力清单"></span>
开发流程见[最小实现](#最小实现)，调用规则见[接口行为](#接口行为)。
