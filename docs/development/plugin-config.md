# 配置与宿主服务

## 值应该放在哪里

| 数据 | 使用方式 | 作用范围 |
| --- | --- | --- |
| 长期配置 | `configSchema` → `createInstance({ config })` | 当前配置实例 |
| 请求参数 | `paramsSchema` → `input.params` | 本次上传或访问 |
| 密码、Token 等 | `x-sensitive` 字段与密钥服务 | 当前实例，持久保存 |
| 运行状态 | `readState/updateState` | 当前实例，持久保存 |
| 临时共享数据 | `context.data` | 本次流水线执行 |
| 保存后结果摘要 | 返回 `details` | 文件的处理结果记录 |

处理插件的配置描述位于对应 `stages` 下；路径和存储插件直接在定义上声明。

## 配置描述字段

下面这些字段共同构成 `Descriptor<R>`；`R` 是该类插件的运行对象类型。路径和存储在定义顶层声明，处理插件在对应 `stages` 下声明。

| 字段 / 方法 | 类型 | 必需 | 作用 |
| --- | --- | --- | --- |
| `configSchemaVersion` | 正整数 | 是 | 配置结构版本，从 `1` 开始 |
| `configSchema` | `Config` | 是 | 根类型为对象的配置 Schema；无配置时使用空对象 Schema |
| `createInstance` | 异步函数 | 是 | 根据配置创建运行对象 |
| `validateConfig` | 异步函数 | 否 | 补充配置语义校验 |
| `migrateConfig` | 异步函数 | 否 | [升级时转换旧配置](./plugin-release.md#migrateconfig-转换旧配置) |
| `uiHints` | `UIHints` | 否 | 表单显示提示 |
| `defaultLocale` | `string` | 是 | 当前描述的内容默认语言 |
| `content` | `Record<string, PluginContent>` | 是 | 按语言保存展示文案；至少提供默认语言条目，无字段文案时可为 `{}` |
| `paramsSchema` | `Config` | 否 | 仅上传和访问阶段支持，声明可接受的请求参数 |

本文中的 `Config` 是 `Record<string, Json>`。`Json` 可以是字符串、数值、布尔值、`null`、数组或 JSON 对象，不包含函数、流或类实例。

## createInstance：创建运行对象

宿主在准备或重新加载配置实例时调用，不是每次请求调用。方法返回的对象可能同时服务多个请求。

```ts
createInstance(input: {
  id: string;
  config: Readonly<Config>;
  services: InstanceServices;
}): Promise<R>;
```

| 输入字段 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `id` | `string` | 否 | 配置实例 ID，不是插件 ID |
| `config` | `Readonly<Config>` | 否 | 校验后的普通配置；敏感值通过密钥服务读取 |
| `services` | `InstanceServices` | 否 | 宿主为当前实例提供的服务，见下表 |

| 类型 / 阶段 | 必须返回的运行对象 |
| --- | --- |
| 路径 | `PathPlugin`，提供 `generate` |
| 存储 | `StoragePlugin`，提供 `write/read/delete` |
| 上传 | `ProcessorPlugin`，提供 `check/process` |
| 访问 | `AccessPlugin`，提供 `check/process` |
| 保存后 | `PostSavePlugin`，提供 `execute` |

可以在这里创建可复用客户端；不要执行某张图片的业务操作。初始化失败时抛错，宿主不会把失败实例当作可用实例。

## validateConfig：补充校验

可选。宿主保存配置时，在结构校验和本地目录解析后调用，检查字段组合等 Schema 未覆盖的规则。

```ts
validateConfig(config: Readonly<Config>): Promise<Array<{
  message: string;
  path?: string;
}>>;
```

唯一参数 `config` 必需，可能包含敏感值。返回空数组表示通过，否则返回错误列表：

| 返回项字段 | 类型 | 必需 | 含义 |
| --- | --- | --- | --- |
| `message` | `string` | 是 | 不含敏感信息的错误说明；核心对外可能替换为通用提示 |
| `path` | `string` | 否 | 错误字段的 JSON Pointer，例如 `/width`；省略表示整体配置 |

不要修改输入或执行远端写入；它不是运行方法，也没有请求取消上下文。

## 固定配置与请求参数

[缩放示例](./processors/upload.md#最小实现) 的 `configSchema` 定义固定宽度，`paramsSchema` 允许本次请求传入可选宽度。插件自行决定优先级：

```ts
const width = Number(params.width ?? config.width);
```

宿主验证并传入请求参数，不会自动将它们合并进 `config`。管理员还需在步骤中启用该参数，否则插件不会收到它。

| 固定配置 | 启用 `width` | 请求参数 | 示例实际使用 |
| --- | --- | --- | --- |
| `1280` | 否 | `width: 800` | `1280` |
| `1280` | 是 | 未传 | `1280` |
| `1280` | 是 | `width: 800` | `800` |

安装 `processor.zip`、配置上传流水线并启用 `width` 后，可通过上传 API 验证。设置以下变量为实际部署地址、上传令牌和配置 ID：

```sh
PICLOOM_URL=http://localhost:3000
PICLOOM_TOKEN=替换为上传令牌
PICLOOM_PROFILE=替换为上传配置ID
curl --fail-with-body "$PICLOOM_URL/api/files" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -F "profileId=$PICLOOM_PROFILE" \
  -F 'file=@image.png' \
  -F 'params={"width":800}'
```

使用宽于 800 像素的静态 PNG 验证输出。访问阶段的参数来自 URL 查询字符串，保存后阶段不提供 `paramsSchema`。其他 API 的传值方式见 [HTTP API](../reference/http-api.md)。

## 配置表单与校验

`configSchema` 描述持久配置，核心据此生成表单并校验。常用写法包括对象的 `properties/required/additionalProperties`、字段类型、`default`、`enum`、长度和数值范围。

`paramsSchema` 更严格：参数只能是可选的字符串、数值或布尔值，不支持嵌套对象、数组、必填字段和默认值。默认行为应由插件的固定配置或代码决定。

项目支持约定的 Schema 子集，并非任意 JSON Schema；完整约束见 [配置 Schema](https://github.com/llleixx/picloom/blob/main/shared/config.ts) 与 [参数 Schema](https://github.com/llleixx/picloom/blob/main/shared/params-schema.ts)。

| 扩展 | 用途 |
| --- | --- |
| `x-sensitive: true` | 将字段按密钥保存，运行时通过密钥服务读取 |
| `x-immutable: true` | 创建后不能直接修改该字段 |
| `uiHints` | 分组、顺序、高级选项、输入样式、显示条件 |
| `content` | 按语言保存插件名称、字段标题、说明和枚举标签 |

## 界面提示与翻译

站点与插件使用同一个 `LocalizedContent<T>` 结构和逐字段解析规则。宿主决定界面语言；插件不自行读取浏览器语言。每份内容声明自己的默认语言，不依赖站点的默认语言。

下面是配置描述的片段，Schema 只定义数据规则，展示文案统一放入 `content`：

```ts
defaultLocale: "en-US",
content: {
  "en-US": {
    configSchema: {
      "/properties/width": { title: "Maximum width", description: "Do not enlarge smaller images" },
    },
    groups: { size: "Size" },
  },
  "zh-CN": {
    configSchema: {
      "/properties/width": { title: "最大宽度", description: "不放大小图" },
    },
    groups: { size: "尺寸" },
  },
},
configSchema: {
  type: "object",
  properties: { width: { type: "integer", minimum: 1 } },
},
uiHints: { "/width": { group: "size", order: 1, advanced: true } },
```

逐字段按「当前语言精确匹配 → 基础语言（如 `zh`）→ 当前内容的 `defaultLocale` → 调用方默认值」解析。缺失、空字符串和纯空白均继续回退。枚举标签也逐项回退，最终使用原枚举值；字段标题未提供时由表单使用字段键。修改默认语言不移动或改写其他语言的内容。

插件身份的 `content` 保存 `name`、`description`；默认语言必须有非空名称。处理插件各阶段的 `content` 保存该阶段的字段文案，拥有自己的 `defaultLocale`，可与身份文案的默认语言不同。路径和存储插件的身份与配置描述在同一层。

`PluginContent` 支持 `name`、`description`、`configSchema`、`paramsSchema` 和 `groups`。Schema 文案通过 JSON Pointer 定位，支持 `title`、`description`、`enumLabels`；枚举标签数量必须与原枚举一致。语言代码必须是规范 BCP 47 形式（如 `zh-CN`），不限制为宿主当前支持的语言。

`uiHints` 使用配置值路径，Schema 文案使用 Schema 内部路径。`group` 是稳定标识，显示名从 `content.groups` 解析。`widget` 支持 `textarea/password`，`visibleWhen` 控制显示；隐藏不等于免除校验。

定义中的 Schema 不再放 `title`、`description`、`x-enumLabels`。宿主仅在显示副本中补充这些标签；不会修改原定义、配置键、枚举值或用户配置。

## 密钥与运行状态

普通 `config` 不包含可直接使用的敏感值。运行方法需要凭证时，通过 `services.readSecrets()` 读取；不要把初始化时的值当作永远不会变化的快照。

密钥和状态服务都返回 `{ value, version }`，更新时传入读到的版本。例如，在运行方法中更新状态的片段：

```ts
const state = await services.readState();
await services.updateState(
  { ...state.value, lastSuccessAt: Date.now() },
  state.version,
);
```

另一调用已更新时会发生版本冲突，应重新读取并重新决定更新内容，不能用旧对象盲目覆盖。状态服务不是密钥存储；凭证放入 `updateSecrets`，其持久化由部署密钥加密。

## 宿主服务接口

`services` 属于当前实例，没有单次请求的取消信号。下列方法的参数都必需，除非标记为可选；返回 `Promise<void>` 表示完成更新，无数据返回。

| 成员 / 签名 | 输入 | 输出与行为 |
| --- | --- | --- |
| `images.sharp` | 按 Sharp API 传入图片和选项 | 返回 Sharp 处理对象，复用宿主的图片库 |
| `log(event: string): void` | 简短事件名 | 写入带实例 ID 的日志，无返回值 |
| `readSecrets(): Promise<{ value: Config; version: number }>` | 无 | 当前凭证对象及其版本 |
| `updateSecrets(value: Config, expectedVersion: number): Promise<void>` | 完整新凭证对象、读取时的版本 | 加密替换凭证；版本不匹配则失败 |
| `readState(): Promise<{ value: Config; version: number }>` | 无 | 当前持久状态及其版本 |
| `updateState(value: Config, expectedVersion: number): Promise<void>` | 完整新状态对象、读取时的版本 | 替换状态；版本不匹配则失败 |

更新方法不是字段合并，需保留的字段应自行带上。日志、定位信息和结果详情都不能包含凭证或带密钥的 URL。

## 调用上下文

运行方法的第二个参数是宿主传入的上下文；不要把它与 `createInstance` 的 `services` 混淆。

| `Context` 字段 / 方法 | 类型 | 可选 | 用途 |
| --- | --- | --- | --- |
| `signal` | `AbortSignal` | 否 | 当前调用的取消信号，传递给网络与流操作 |
| `requestId` | `string` | 否 | 当前调用的关联标识，用于日志排查 |
| `log(event)` | `(event: string) => void` | 否 | 写入带调用关联信息的事件日志，无返回值 |

处理阶段还增加 `data`：

| 上下文类型 | 使用位置 | `data` 能力 |
| --- | --- | --- |
| `Context` | 路径与存储运行方法 | 无 `data` |
| `CheckContext` | 上传、访问的 `check` | 只读 `get` |
| `PipelineContext` | 上传、访问的 `process` 和保存后的 `execute` | `get` 与 `set` |

```ts
data.get(namespace: string): Json | undefined;
data.set(namespace: string, value: Json): void;
```

参数均必需。`get` 返回副本，未设置时返回 `undefined`；`set` 覆盖该命名空间，无返回值。数据仅存在于本次流水线执行，总量上限 256 KiB，不能用它跨请求持久保存状态。

## 文件与输出

`FileInput` 由宿主提供，不是磁盘文件名：

| 成员 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `metadata` | `Readonly<Metadata>` | 否 | 只读元数据，字段见下表 |
| `openRead()` | `() => Promise<ReadableStream<Uint8Array>>` | 否 | 无参数，返回可读取图片内容的流 |

| `Metadata` 字段 | 类型 | 可选 | 单位 / 含义 |
| --- | --- | --- | --- |
| `mimeType` | `string \| null` | 否 | MIME 类型，未知时为 `null` |
| `byteSize` | `number \| null` | 否 | 字节数，未知时为 `null` |
| `width`、`height` | `number \| null` | 否 | 像素宽高，未知时为 `null` |
| `animated` | `boolean` | 是 | 是否为动图 |
| `alpha` | `boolean` | 是 | 是否有透明通道 |

`Output` 继承 `FileInput`，另有只读 `handle: string` 和 `write(stream: ReadableStream<Uint8Array>): Promise<void>`。`handle` 是宿主管理的不透明标识，不是文件路径。

在 `process` 中通过无参数的 `createOutput(): Promise<Output>` 获得输出，传入一个流并等待 `write` 完成；同一输出只允许写一次。不能自行创建句柄，或在调用结束后继续使用宿主提供的文件、输出和流。取消规则见 [错误、取消与并发](./plugin-errors.md#取消与资源释放)。
