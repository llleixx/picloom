# @picloom/plugin-sdk

Public TypeScript interfaces and runtime helpers for Picloom plugins. Maintained
in the Picloom repository; plugin authors do not need to clone that repository.

**Publication status: prepared locally; not yet published to npm.** The registry
commands below apply after release. For unpublished local tarballs, see
[quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html#本地压缩包).

```sh
bun add --dev @picloom/plugin-sdk@0.1.0 sharp@0.34.5
```

```ts
import { PluginError, type Definition } from "@picloom/plugin-sdk";
```

Use ESM with TypeScript `moduleResolution: "Bundler"` and Bun types. The SDK
contains types for `path`, `storage`, and `processor` plugins, configuration,
host services, errors, and file/stream helpers. It does not start Picloom.

Display text uses semantic keys and a shared `messages` catalog:

```ts
const labels = {
  defaultLocale: "en-US",
  nameKey: "package.name",
  messages: {
    "en-US": { "package.name": "My plugin" },
    "zh-CN": { "package.name": "我的插件" },
  },
} satisfies import("@picloom/plugin-sdk").PluginLocalization;
```

Put these fields on the definition, not `plugin.json`. Identities require `nameKey`
and may declare `descriptionKey`. All stages reference the single package-level `defaultLocale/messages` catalog.
Stages cannot declare their own localization metadata. Field `x-ui`
hints reference `labelKey`, `descriptionKey`, `enumKeys`, and `groupKey`; they also
support `order`, `advanced`, `widget` and `visibleWhen`. The default catalog must
contain every referenced or translated key. Supplied values must be nonblank.
Display resolves current locale, base language, then default locale, finally the
key itself. This applies only to author copy, never administrator configuration.
See [display hints and translations](https://llleixx.github.io/picloom/development/plugin-config.html#界面提示与翻译).

`sharp` is an optional peer because the public `services.images.sharp` type
references its declarations. Install it as a development dependency for complete
type checking, even for the initial path template. At runtime use
`services.images.sharp`; do not import or bundle your own Sharp runtime.

Bundle the SDK's runtime helpers with your plugin. Node/Bun builtins remain host
dependencies. Picloom does not install npm dependencies from plugin ZIPs.

| SDK                 | Plugin API | Host                                     |
| ------------------- | ---------- | ---------------------------------------- |
| 0.1.0 (unpublished) | 1          | Current Picloom 0.1.0 development source |

Plugin development uses Bun 1.4.3+; Node.js and npm CLI are not required.
SDK versions and plugin code versions are independent; `apiVersion` is the host protocol, not the SDK version.
Interfaces may change before 1.0; pin the SDK version and review release notes.

## Configuration contract

Schemas have dedicated types: `ConfigSchema`, `ParamsSchema`, `FieldSchema`,
`ParameterSchema`, `SchemaConstraint` and `ParameterConstraint`. `Config` remains
the type for actual configuration values. Inline declarations are checked through
`satisfies Definition<...>`; use `satisfies ConfigSchema` or `satisfies ParamsSchema`
when extracting a schema into a separate variable. Types catch misspelled type
names, incorrectly typed constraints, nested request parameters and defaults in
constraint branches. The host still checks field references and value validity.

`configSchema` is an optional, non-sensitive object schema. Omission means no
custom configuration: only `{}` is accepted. The host normalizes omission to a
closed empty object schema, equivalent to declaring one explicitly. An explicit
`null` or `{}` is not a valid schema. `configSchemaVersion` remains required.
Static `properties/items`
define objects, homogeneous arrays, scalars and null. Composition
(`allOf/anyOf/oneOf/not/if/then/else`) only constrains declared fields; branches
cannot introduce fields, defaults or extensions. Objects reject undeclared
properties. Values are not coerced; numbers must be finite and `integer` values
must be safe integers. See the [supported subset and scenario comparison](https://llleixx.github.io/picloom/development/plugin-config.html#三类-schema-的边界).

Defaults initialize new drafts and explicitly added array items. Saving, copying,
reading and upgrade previews never fill missing fields from schema defaults.
`migrateConfig` explicitly supplies new values; previews check the target schema,
and saving also runs `validateConfig`, immutable-field and concurrency checks.
Missing values, empty strings, false, zero, empty arrays and null remain distinct;
each submitted value must satisfy its declared type and constraints.

Sensitive values are excluded from runtime `config`; read them through
`services.readSecrets()`. Management APIs use `secretEdits`: omission or `preserve`
keeps the old value, `replace` supplies a value, and `clear` removes it. Empty
strings are replacements, not clearing. Sensitive defaults are rejected; an array
with sensitive descendants is stored and edited as one sensitive value.
Immutable fields protect existing values during edits and upgrades, including
sensitive values. Upgrades may initialize previously missing immutable fields.

`paramsSchema` is optional on upload/access stages. Omission means no custom
parameters; the host supplies a closed empty object schema, and undeclared or
disabled parameters never reach the plugin. Request parameters are flat scalars. Field-local
composition and defaults are supported; defaults only initialize explicitly added
link-builder inputs and are never applied by the server. Conflicting defaults for
one public parameter leave it unset for manual entry. Only enabled, supplied
parameters reach a plugin. Empty strings, false and zero are transmitted distinctly
from missing parameters. JSON uses typed scalar values; URL query strings are
parsed according to the declared scalar type.

The SDK has no dependency on the theme SDK or host shared modules. Catalog
resolution and declaration validation belong to the host; this package exports
plugin declaration types, not host localization utilities.

## 中文

本包独立提供插件类型与辅助函数，不包含 Picloom 服务。当前仅准备本地发布产物，
尚未发布 npm。宿主兼容范围见上表，不保证任意旧版开发构建均兼容。

展示文案统一使用显式翻译键和 `messages` 字典，默认语言必须包含所有引用和翻译的键。
身份必填 `nameKey`，可选 `descriptionKey`；各阶段共用插件顶层字典，阶段不声明本地化元数据，名称不放在包清单中。
字段内的 `x-ui` 引用标签、说明、枚举和分组的翻译键，并声明顺序、输入样式等提示。
作者文案按当前语言、基础语言、包默认语言回退；管理员配置值不回退。
不接受旧的 `content/uiHints` 声明。完整结构见上方文档链接。

Schema 使用独立类型：`ConfigSchema`、`ParamsSchema`、`FieldSchema`、`ParameterSchema`、
`SchemaConstraint` 和 `ParameterConstraint`；`Config` 只表示实际配置数据。
内联声明通过 `satisfies Definition<...>` 检查，独立变量使用 `satisfies ConfigSchema`
或 `satisfies ParamsSchema`。类型可发现类型名拼写、约束值类型、嵌套请求参数及分支默认值等
错误；字段引用和实际值是否合法仍由宿主检查。

`configSchema` 可省略，表示没有自定义配置项，只接受 `{}`；宿主统一处理为空对象
Schema，与显式声明空对象 Schema 等价。`null` 或缺少 `type` 的 `{}` 不是有效 Schema，
`configSchemaVersion` 仍必需。显式声明的根节点必须为非敏感对象。静态 `properties/items` 定义对象、
同类数组、标量及 `null`；组合分支只能约束已有字段，不能增加字段、默认值或扩展。
对象拒绝未知字段，不强转值类型；数值必须有限，`integer` 必须是安全整数。
支持范围见[三类 Schema 的边界](https://llleixx.github.io/picloom/development/plugin-config.html#三类-schema-的边界)。

默认值仅初始化新草稿和显式新增的数组项；保存、复制、读取和升级预览不补默认值。
`migrateConfig` 显式提供新值；预览按目标 Schema 校验，保存时还执行 `validateConfig`、
不可变字段及并发检查。缺失、空字符串、`false`、`0`、空数组和 `null` 分别处理，
实际值须符合对应字段的类型和约束。

运行时 `config` 不包含敏感值，使用 `services.readSecrets()` 读取。管理 API 的
`secretEdits` 省略或 `preserve` 表示保留，`replace` 提供新值，`clear` 删除值；
替换为空字符串不等于删除。敏感值不得有默认值；数组内存在敏感字段时，整个数组
作为敏感值保存和编辑。已有不可变值在编辑和升级时受保护，包含其中的敏感值；
升级允许初始化原先缺失的不可变字段。

上传、访问阶段可省略 `paramsSchema`，表示没有自定义请求参数，宿主统一处理为空对象
Schema；未声明或未启用的参数不传给插件。请求参数只支持一层可选标量；字段内可声明组合约束和默认值。
默认值只用于访问链接界面显式添加参数，服务端不补值；同名参数默认值冲突时保持
未设置，供手填。插件只收到已启用且实际传入的参数；空字符串、`false`、`0` 与缺失
分别传输。JSON 使用对应标量类型，URL 查询字符串按声明类型解析。

SDK 不依赖主题 SDK 或宿主 `shared/`；字典解析和声明校验由宿主负责，SDK 不导出宿主翻译工具。

Sharp 为可选 peer dependency，但完整类型检查仍需安装它的声明，因此模板将
Sharp 放在开发依赖中。运行时使用宿主的 `services.images.sharp`，不打包另一套原生库。

插件开发使用 Bun；请将首次安装生成的 `bun.lock` 提交到自己的插件仓库。
普通插件以 ZIP 安装到 Picloom，无需将插件自身发布到 npm。

See [quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html)
and [host services](https://llleixx.github.io/picloom/development/plugin-config.html).
