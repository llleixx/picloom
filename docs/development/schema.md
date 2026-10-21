# Schema 参考

插件配置、请求参数和主题配置使用以下 Schema 子集。首次添加配置请先看[配置与请求参数](./plugin-config.md)或[主题配置](./themes.md#配置与多语言文本)。

## 三类 Schema 的边界

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

宿主不将配置字符串强转为数值，不移除未知字段，也不在校验时补值。请求查询字符串会按声明类型解析；JSON 请求参数必须直接使用对应 JSON 类型。

| 扩展                | 用途                                                     |
| ------------------- | -------------------------------------------------------- |
| `x-sensitive: true` | 将字段按密钥保存，运行时通过密钥服务读取                 |
| `x-immutable: true` | 创建后不能直接修改该字段                                 |
| `x-ui`              | 字段内的翻译键、分组、顺序、高级选项、输入样式、显示条件 |

## 组合约束

字段结构与扩展只能在静态 `properties/items` 树声明。`allOf/anyOf/oneOf/not/if/then/else` 只约束已声明字段，不能增加字段、`default` 或任何 `x-*` 扩展。

## 默认值与保存

`default` 用于初始化新草稿和显式新增的数组项。以下保存规则针对插件；主题的草稿校验见[主题配置](./themes.md#配置与多语言文本)。后台新建表单加载一次默认值，管理员删除后不再补回。新建及编辑 API 都按提交的完整配置校验和保存，不补默认值；直接调用 API 时需要提交全部必需字段。复制保留字段缺失状态；升级预览只执行 `migrateConfig` 并校验，新值由迁移函数明确提供，或者由管理员补充。

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

## 敏感字段与不可变字段

插件配置根节点必须为非敏感对象。字段通过 `x-sensitive: true` 声明为密钥，`createInstance` 只收到普通配置；运行时使用[密钥服务](./plugin-services.md#密钥与运行状态)读取。管理接口的凭据编辑格式见 [HTTP API](../reference/http-api.md#插件配置与敏感值)。

敏感字段不得声明默认值，祖先默认值也不得包含敏感值。数组内的不可变性必须在数组节点声明。

敏感对象整体保存为凭据；数组内任意静态字段敏感时，整个数组作为一个凭据值，编辑路径指向数组。不得为这些敏感值提供默认值，包括敏感数组的空数组默认值。

`x-immutable` 在配置保存时比较新旧实际值，缺失也参与比较；声明在对象上时保护整个对象，包括其中的敏感值。普通编辑不能补上原先缺失的不可变字段。升级同时检查新旧 Schema，不能修改或删除已有不可变值，但允许初始化原先缺失的不可变字段；复制则创建新实例。更换已有存储目标应创建新实例。

本地目录另有路径处理：`localDirectory.configPath` 指向的相对路径在保存时解析为应用数据目录下的绝对路径，再执行补充校验和不可变比较，详见[存储插件的本地目录声明](./plugin-storage.md)。

## 请求参数

`paramsSchema` 的参数只能是可选的一层字符串、数值或布尔值。字段可用普通约束和字段内组合约束；不支持嵌套对象、数组、null、必填或跨参数约束。`default` 仅供访问链接界面显式添加参数时初始化，服务端不补值。公开同名参数约束须一致；默认声明不一致（包括部分未声明）时仍可手填，但不选择任意一个默认值。空字符串传为 `?key=`，false 和 0 正常传输，未设置才省略。

## SDK 类型

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
