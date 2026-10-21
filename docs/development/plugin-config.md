# 配置与宿主服务

## 值应该放在哪里

| 数据           | 使用方式                                      | 作用范围           |
| -------------- | --------------------------------------------- | ------------------ |
| 长期配置       | `configSchema` → `createInstance({ config })` | 当前配置实例       |
| 请求参数       | `paramsSchema` → `input.params`               | 本次上传或访问     |
| 密码、Token 等 | `x-sensitive` 字段与密钥服务                  | 当前实例，持久保存 |
| 运行状态       | `readState/updateState`                       | 当前实例，持久保存 |
| 临时共享数据   | `context.data`                                | 本次流水线执行     |
| 保存后结果摘要 | 返回 `details`                                | 文件的处理结果记录 |

处理插件的配置描述位于对应 `stages` 下；路径和存储插件直接在定义上声明。

## 配置描述字段

下面这些字段共同构成 `Descriptor<R>`；`R` 是该类插件的运行对象类型。路径和存储在定义顶层声明，处理插件在对应 `stages` 下声明。

| 字段 / 方法           | 类型                                     | 必需 | 作用                                                             |
| --------------------- | ---------------------------------------- | ---- | ---------------------------------------------------------------- |
| `configSchemaVersion` | 正整数                                   | 是   | 配置结构版本，从 `1` 开始                                        |
| `configSchema`        | `ConfigSchema`                           | 否   | 根类型为对象的配置 Schema；省略表示没有自定义配置项，只接受 `{}` |
| `createInstance`      | 异步函数                                 | 是   | 根据配置创建运行对象                                             |
| `validateConfig`      | 异步函数                                 | 否   | 补充配置语义校验                                                 |
| `migrateConfig`       | 异步函数                                 | 否   | [升级时转换旧配置](./plugin-release.md#migrateconfig-转换旧配置) |
| `paramsSchema`        | `ParamsSchema`                           | 否   | 仅上传和访问阶段支持，声明可接受的请求参数                       |

本文中的 `Config` 是 `Record<string, Json>`。`Json` 可以是字符串、数值、布尔值、`null`、数组或 JSON 对象，不包含函数、流或类实例。

SDK 将配置数据 `Config` 与声明规则分开：`ConfigSchema` 描述配置，`ParamsSchema` 描述请求参数，`FieldSchema` 描述配置字段，`SchemaConstraint` 描述组合分支。直接在 `satisfies Definition<...>` 中填写即可获得类型提示；将 Schema 提取为变量时，使用对应类型：

```ts
import type { ConfigSchema } from "@picloom/plugin-sdk";

const configSchema = {
  type: "object",
  properties: {
    width: { type: "integer", minimum: 1, default: 1280 },
  },
} satisfies ConfigSchema;
```

类型检查可以发现类型名拼写、关键字值类型、请求参数嵌套及分支内默认值等错误。字段引用是否存在、默认值是否满足约束等仍由宿主校验；TypeScript 类型不会改变配置值或保存规则。

## createInstance：创建运行对象

宿主在准备或重新加载配置实例时调用，不是每次请求调用。方法返回的对象可能同时服务多个请求。

```ts
createInstance(input: {
  id: string;
  config: Readonly<Config>;
  services: InstanceServices;
}): Promise<R>;
```

| 输入字段   | 类型               | 可选 | 含义                                     |
| ---------- | ------------------ | ---- | ---------------------------------------- |
| `id`       | `string`           | 否   | 配置实例 ID，不是插件 ID                 |
| `config`   | `Readonly<Config>` | 否   | 校验后的普通配置；敏感值通过密钥服务读取 |
| `services` | `InstanceServices` | 否   | 宿主为当前实例提供的服务，见下表         |

| 类型 / 阶段 | 必须返回的运行对象                        |
| ----------- | ----------------------------------------- |
| 路径        | `PathPlugin`，提供 `generate`             |
| 存储        | `StoragePlugin`，提供 `write/read/delete` |
| 上传        | `ProcessorPlugin`，提供 `check/process`   |
| 访问        | `AccessPlugin`，提供 `check/process`      |
| 保存后      | `PostSavePlugin`，提供 `execute`          |

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

| 返回项字段 | 类型     | 必需 | 含义                                                     |
| ---------- | -------- | ---- | -------------------------------------------------------- |
| `message`  | `string` | 是   | 不含敏感信息的错误说明；核心对外可能替换为通用提示       |
| `path`     | `string` | 否   | 错误字段的 JSON Pointer，例如 `/width`；省略表示整体配置 |

不要修改输入或执行远端写入；它不是运行方法，也没有请求取消上下文。

## 固定配置与请求参数

[缩放示例](./processors/upload.md#最小实现) 的 `configSchema` 定义固定宽度，`paramsSchema` 允许本次请求传入可选宽度。插件自行决定优先级：

```ts
const width = Number(params.width ?? config.width);
```

宿主验证并传入请求参数，不会自动将它们合并进 `config`。管理员还需在步骤中启用该参数，否则插件不会收到它。

| 固定配置 | 启用 `width` | 请求参数     | 示例实际使用 |
| -------- | ------------ | ------------ | ------------ |
| `1280`   | 否           | `width: 800` | `1280`       |
| `1280`   | 是           | 未传         | `1280`       |
| `1280`   | 是           | `width: 800` | `800`        |

安装[上传处理示例](./processors/upload.md#接入并验证)构建的 ZIP、配置上传流水线并启用 `width` 后，可通过上传 API 验证。设置以下变量为实际部署地址、上传令牌和配置 ID：

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

`paramsSchema` 的参数只能是可选的一层字符串、数值或布尔值。字段可用普通约束和字段内组合约束；不支持嵌套对象、数组、null、必填或跨参数约束，因为传输、逐项启用和无参数访问语义尚未定义这些能力。`default` 仅供访问链接界面显式添加参数时初始化，服务端不补值。公开同名参数约束须一致；默认声明不一致（包括部分未声明）时仍可手填，但不选择任意一个默认值。空字符串传为 `?key=`，false 和 0 正常传输，未设置才省略。

### 三类 Schema 的边界

三者均可省略；显式声明时，根节点必须为 `object`。能力差异如下：

| 能力 | 插件配置 | 请求参数 | 主题配置 |
| --- | --- | --- | --- |
| 字段类型 | 对象、数组、字符串、数值、布尔、`null` | 字符串、数值、布尔 | 对象、数组、字符串、数值、布尔、`null` |
| 必填 | 支持 | 不支持 | 支持 |
| 组合约束 | 支持 | 仅单个参数内 | 支持 |
| 敏感与不可变字段 | 支持 | 不支持 | 不支持 |
| 多语言文本 | 不支持 | 不支持 | 支持 |

省略表示没有自定义配置或参数，与显式声明空对象 Schema 等价。插件和主题只接受空配置 `{}`，未声明或未启用的请求参数不传给插件。`null` 和缺少 `type` 的 `{}` 不是有效 Schema。插件的 `configSchemaVersion` 仍需声明。

项目支持以下 Schema 子集；未列出的关键字不接受。`$schema` 不能扩展宿主支持范围。

| 用途 | 支持的关键字 |
| --- | --- |
| 结构 | `$schema`、`type`、`properties`、`required`、`additionalProperties`、`items` |
| 值与初始化 | `enum`、`const`、`default` |
| 数值 | `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf` |
| 字符串 | `minLength`、`maxLength`、`pattern`、`format` |
| 数组 | `minItems`、`maxItems`、`uniqueItems` |
| 组合 | `allOf`、`anyOf`、`oneOf`、`not`、`if`、`then`、`else` |
| 场景扩展 | `x-ui`，以及上表对应场景的 `x-sensitive`、`x-immutable`、`x-localized` |

静态字段必须声明单一 `type`，不支持类型数组、布尔 Schema、`$ref`、开放对象或元组数组。对象的 `additionalProperties` 只允许省略或设为 `false`，省略也拒绝未声明字段。字段名支持 Unicode 和 JSON Pointer 转义字符，拒绝 `__proto__`、`constructor`、`prototype`；请求参数名还须非空。

`format` 支持 `date`、`time`、`date-time`、`duration`、`email`、`hostname`、`ipv4`、`ipv6`、`uri`、`uri-reference`、`uuid`、`regex`。`integer` 类型必须处于 JavaScript 安全整数范围，数值必须有限。`required` 只表示字段存在：空字符串是否允许由 `minLength` 等约束决定，`null` 只匹配 `type: "null"`。

宿主不将配置字符串强转为数值，不移除未知字段，也不在校验时补值。请求查询字符串会按声明类型解析；JSON 请求参数必须直接使用对应 JSON 类型。声明和校验实现见 [字段 Schema](https://github.com/llleixx/picloom/blob/main/shared/field-schema.ts)、[参数 Schema](https://github.com/llleixx/picloom/blob/main/shared/params-schema.ts) 和 [值校验](https://github.com/llleixx/picloom/blob/main/src/core/schema-validation.ts)。

| 扩展                | 用途                                                     |
| ------------------- | -------------------------------------------------------- |
| `x-sensitive: true` | 将字段按密钥保存，运行时通过密钥服务读取                 |
| `x-immutable: true` | 创建后不能直接修改该字段                                 |
| `x-ui`              | 字段内的翻译键、分组、顺序、高级选项、输入样式、显示条件 |

字段结构与扩展只能在静态 `properties/items` 树声明。`allOf/anyOf/oneOf/not/if/then/else` 只约束已声明字段，不能增加字段、`default` 或任何 `x-*` 扩展。数组内不可变性必须在数组节点声明；数组内存在敏感字段时，整个数组作为敏感值保存。敏感字段不得声明默认值，祖先默认值也不得包含敏感值。

### 默认值与保存

`default` 只用于显式生成初始草稿。后台新建表单加载一次默认值，管理员删除后不再补回。新建及编辑 API 都按提交的完整配置校验和保存，不补默认值；直接调用 API 时需要提交全部必需字段。复制保留字段缺失状态；升级预览只执行 `migrateConfig` 并校验，新值由迁移函数明确提供，或者由管理员补充。

缺失、空字符串、`false`、`0` 和空数组分别保留。必需字段用 `required` 声明，条件必需字段用约束分支表达。运行时不应通过隐式默认值撤销管理员的删除操作。

初始化会递归使用子字段默认值；没有默认值或子默认值的对象保持缺失。默认对象可以省略稍后由管理员补齐的必需字段；默认值本身的类型、局部值约束和数组约束仍需满足声明。`default` 不等于 `const` 或 `required`。

例如，以下配置在新建草稿时得到 `{ resize: false, width: 1280 }`；保存 `{ resize: false }` 会保留 `width` 缺失，保存 `{ resize: true }` 则因缺少 `width` 失败：

```ts
configSchema: {
  type: "object",
  properties: {
    resize: { type: "boolean", default: false },
    width: { type: "integer", minimum: 1, default: 1280 },
  },
  required: ["resize"],
  if: { properties: { resize: { const: true } }, required: ["resize"] },
  then: { required: ["width"] },
},
```

### 敏感字段与不可变字段

管理接口的 `config` 是完整的普通配置对象；敏感值通过 `secretEdits` 按 JSON Pointer 单独提交。省略某个敏感路径的编辑表示保留原值，`replace` 提供新值，`clear` 删除值。把敏感值直接放进 `config` 不会更新凭据；敏感字符串替换为 `""` 与清除是两种操作，是否允许空串由 Schema 决定。完整配置组装后再校验和拆分存储，`createInstance` 只收到普通部分。

敏感对象整体保存为凭据；数组内任意静态字段敏感时，整个数组作为一个凭据值，编辑路径指向数组。不得为这些敏感值提供默认值，包括敏感数组的空数组默认值。

`x-immutable` 在配置保存时比较新旧实际值，缺失也参与比较；声明在对象上时保护整个对象，包括其中的敏感值。普通编辑不能补上原先缺失的不可变字段。升级同时检查新旧 Schema，不能修改或删除已有不可变值，但允许初始化原先缺失的不可变字段；复制则创建新实例。更换已有存储目标应创建新实例。

本地目录另有路径处理：`localDirectory.configPath` 指向的相对路径在保存时解析为应用数据目录下的绝对路径，再执行补充校验和不可变比较，详见[存储插件的本地目录声明](./plugin-storage.md)。

## 界面提示与翻译

插件和主题统一使用显式翻译键与 `messages` 字典。Schema 定义数据规则，字段内的 `x-ui` 引用语义键，不使用 Schema 路径作为翻译索引。宿主决定界面语言；包的 `defaultLocale` 仅用于作者文案回退，与站点默认语言独立。

```ts
nameKey: "package.name",
defaultLocale: "en-US",
messages: {
  "en-US": {
    "package.name": "Image size",
    "width.label": "Maximum width",
    "width.help": "Do not enlarge smaller images",
    "group.size": "Size",
  },
  "zh-CN": {
    "package.name": "图片尺寸",
    "width.label": "最大宽度",
    "width.help": "不放大小图",
    "group.size": "尺寸",
  },
},
configSchema: {
  type: "object",
  properties: {
    width: {
      type: "integer", minimum: 1,
      "x-ui": {
        labelKey: "width.label", descriptionKey: "width.help",
        groupKey: "group.size", order: 1, advanced: true,
      },
    },
  },
},
```

身份必填 `nameKey`，插件可另设 `descriptionKey`。整个插件在定义顶层声明唯一的 `defaultLocale/messages`，身份、各阶段配置和请求参数共享这一字典。阶段不接受本地化元数据，也没有继承或覆盖规则。

默认语言字典必须包含全部使用或翻译的键，值必须是非空白字符串；其他语言可以只翻译一部分。显示时逐键按「当前语言 → 基础语言（如 `zh`）→ 包默认语言」查找，仍找不到则显示键名。语言标识使用规范 BCP 47，插件字典不限于核心支持语言。声明未引用的键可以保留，用于复用文案。没有 `labelKey` 的字段显示字段名，没有 `enumKeys` 的枚举显示原值。

`x-ui` 支持 `labelKey`、`descriptionKey`、`enumKeys`（按枚举顺序一一对应）、`groupKey`、`order`、`advanced`、`widget`（`textarea/password`）和 `visibleWhen: { path, equals }`。可见性条件的 `path` 是配置值的 JSON Pointer；隐藏字段仍执行业务校验。`x-ui` 只影响显示，不改变数据默认值、约束或密钥行为。

主题共用上述普通 UI 提示和字段编辑器，但不支持插件密钥与不可变扩展；多语言字段由主题语言层适配，详见[主题开发](./themes.md)。

不接受旧的 `content/uiHints` 或 Schema 内的直接文案。管理接口返回宿主标准化后的 Schema 和包字典（省略的 Schema 显式表示为空对象 Schema），编辑器通过 `fieldText()` 解析 `x-ui`，不再生成旧的 `title/description/x-enumLabels` 字段，也不会修改原定义或用户配置。管理员输入的多语言内容只读取当前语言，空值保持为空，不使用作者字典的回退规则。

## 宿主实现边界

插件和主题共用 `shared/package-localization.ts` 中的字典解析、翻译键校验、Schema 遍历和字段文案解析。该模块不依赖 SDK、前端框架或服务端业务，也不决定某类包允许哪些控件。

插件身份和表单能力由 `src/plugins/declaration.ts` 校验；主题规则由 `src/themes/schema.ts` 校验。插件展示适配器与主题表单调用同一个 `fieldText()`，但各自保留数据编辑方式。管理员配置值不经过作者文案解析器。

两个 SDK 各自发布自己的协议类型，不互相依赖，也不导入宿主的 `shared/`。宿主通过结构类型使用这些声明；插件作者不需要引用宿主模块，主题通过注入的 `ctx.t()` 读取字典。宿主的翻译工具不作为插件 SDK 导出。

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

| 成员 / 签名                                                            | 输入                         | 输出与行为                            |
| ---------------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| `images.sharp`                                                         | 按 Sharp API 传入图片和选项  | 返回 Sharp 处理对象，复用宿主的图片库 |
| `log(event: string): void`                                             | 简短事件名                   | 写入带实例 ID 的日志，无返回值        |
| `readSecrets(): Promise<{ value: Config; version: number }>`           | 无                           | 当前凭证对象及其版本                  |
| `updateSecrets(value: Config, expectedVersion: number): Promise<void>` | 完整新凭证对象、读取时的版本 | 加密替换凭证；版本不匹配则失败        |
| `readState(): Promise<{ value: Config; version: number }>`             | 无                           | 当前持久状态及其版本                  |
| `updateState(value: Config, expectedVersion: number): Promise<void>`   | 完整新状态对象、读取时的版本 | 替换状态；版本不匹配则失败            |

更新方法不是字段合并，需保留的字段应自行带上。日志、定位信息和结果详情都不能包含凭证或带密钥的 URL。

## 调用上下文

运行方法的第二个参数是宿主传入的上下文；不要把它与 `createInstance` 的 `services` 混淆。

| `Context` 字段 / 方法 | 类型                      | 可选 | 用途                                   |
| --------------------- | ------------------------- | ---- | -------------------------------------- |
| `signal`              | `AbortSignal`             | 否   | 当前调用的取消信号，传递给网络与流操作 |
| `requestId`           | `string`                  | 否   | 当前调用的关联标识，用于日志排查       |
| `log(event)`          | `(event: string) => void` | 否   | 写入带调用关联信息的事件日志，无返回值 |

处理阶段还增加 `data`：

| 上下文类型        | 使用位置                                    | `data` 能力    |
| ----------------- | ------------------------------------------- | -------------- |
| `Context`         | 路径与存储运行方法                          | 无 `data`      |
| `CheckContext`    | 上传、访问的 `check`                        | 只读 `get`     |
| `PipelineContext` | 上传、访问的 `process` 和保存后的 `execute` | `get` 与 `set` |

```ts
data.get(namespace: string): Json | undefined;
data.set(namespace: string, value: Json): void;
```

参数均必需。`get` 返回副本，未设置时返回 `undefined`；`set` 覆盖该命名空间，无返回值。数据仅存在于本次流水线执行，总量上限 256 KiB，不能用它跨请求持久保存状态。

## 文件与输出

`FileInput` 由宿主提供，不是磁盘文件名：

| 成员         | 类型                                        | 可选 | 含义                           |
| ------------ | ------------------------------------------- | ---- | ------------------------------ |
| `metadata`   | `Readonly<Metadata>`                        | 否   | 只读元数据，字段见下表         |
| `openRead()` | `() => Promise<ReadableStream<Uint8Array>>` | 否   | 无参数，返回可读取图片内容的流 |

| `Metadata` 字段   | 类型             | 可选 | 单位 / 含义                |
| ----------------- | ---------------- | ---- | -------------------------- |
| `mimeType`        | `string \| null` | 否   | MIME 类型，未知时为 `null` |
| `byteSize`        | `number \| null` | 否   | 字节数，未知时为 `null`    |
| `width`、`height` | `number \| null` | 否   | 像素宽高，未知时为 `null`  |
| `animated`        | `boolean`        | 是   | 是否为动图                 |
| `alpha`           | `boolean`        | 是   | 是否有透明通道             |

`Output` 继承 `FileInput`，另有只读 `handle: string` 和 `write(stream: ReadableStream<Uint8Array>): Promise<void>`。`handle` 是宿主管理的不透明标识，不是文件路径。

在 `process` 中通过无参数的 `createOutput(): Promise<Output>` 获得输出，传入一个流并等待 `write` 完成；同一输出只允许写一次。不能自行创建句柄，或在调用结束后继续使用宿主提供的文件、输出和流。取消规则见 [错误、取消与并发](./plugin-errors.md#取消与资源释放)。
