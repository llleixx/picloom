# 打包与升级

本文面向插件作者，解释可安装 ZIP 的构建与升级。首次开发从[快速开始](./plugin-tooling.md)进入；
SDK 与创建工具的 npm 发布由[插件工具维护](./plugin-tooling-maintenance.md)说明。

## ZIP 结构

```text
plugin.json
index.js
```

`plugin.json` 必须位于 ZIP 根目录，`entry` 指向包内 `.js` 文件。入口默认导出插件定义，清单与定义的 ID、版本、类型和 API 版本须一致。外部插件 ID 不能使用 `builtin.` 前缀。

ZIP 上传大小上限为 20 MiB。不要把源码目录整体压缩后嵌套在包内，也不要包含 `.env`、凭证或开发数据。

## 构建依赖

独立模板先用 `bun run typecheck` 检查类型，再用 `bun run build` 打包并校验默认导出与清单的身份字段，
最后生成 `dist/<插件ID>-<版本>.zip`。它使用 JavaScript ZIP 库，无需系统 `zip` 命令。
构建会执行自己的模块顶层代码，不应在顶层执行网络请求等副作用。

使用 Bun 目标和 ESM 输出，将需要的 JavaScript 依赖随入口打包。仅声明依赖不会让 Picloom 安装时自动执行包管理器；也不要假设宿主具有任意第三方包。

图片处理使用 `services.images.sharp`，避免把另一套 Sharp 原生依赖打入包中。
Sharp 仍作为开发依赖提供 SDK 所需类型。SDK 可随包打入，`PluginError` 使用结构协议识别，不依赖双方共享同一个类实例。

模板仅打包单 JavaScript 入口。动态计算的导入、原生模块、运行时相对资源和额外产物
需要自行明确打包方式；构建脚本会拒绝已识别的未打包导入与额外输出。
`node:` 内置模块由 Bun 兼容层提供，不需要启动 Node.js。

## 三种版本各管什么

| 字段 | 作用 | 何时修改 |
| --- | --- | --- |
| `apiVersion` | 插件与宿主的接口协议，当前为 `1` | 接入宿主支持的另一版协议时 |
| `version` | 插件代码版本 | 发布代码变更时 |
| `configSchemaVersion` | 配置结构版本；处理插件按阶段声明 | 配置结构变化时 |

SDK 依赖版本另外记录在 `package.json`，不要把它与上述三个字段混淆。

同 ID、同版本不能覆盖安装。只修改代码也应发布新的插件版本；不改变配置结构时不必增加 `configSchemaVersion`。

## 升级配置实例

安装新包只提供新版本，不会自动切换所有实例：

1. 构建并安装新版本。
2. 编辑使用该插件的存储源、上传配置或流水线步骤。
3. 选择新版本，查看迁移预览，补齐或修正配置。
4. 应用升级并验证实际读写或处理结果。

## migrateConfig：转换旧配置

可选。宿主生成升级预览时调用，位于路径/存储定义顶层，或处理插件的对应阶段描述中。

```ts
migrateConfig(input: {
  from: { pluginVersion: string; configSchemaVersion: number };
  apiVersion: 1;
  config: Config;
}): Promise<Config>;
```

| 输入字段 | 类型 | 可选 | 含义 |
| --- | --- | --- | --- |
| `from.pluginVersion` | `string` | 否 | 原实例使用的插件代码版本 |
| `from.configSchemaVersion` | `number` | 否 | 原实例的配置结构版本 |
| `apiVersion` | `1` | 否 | 本次迁移使用的宿主协议版本 |
| `config` | `Config` | 否 | 旧配置副本，可能包含已解密的敏感值 |

宿主不会根据目标 Schema 补默认值；新增必需值由此方法明确提供，缺失时在升级预览中显示校验错误。确认保存不会再次运行迁移或补默认值。

返回完整的新 `Config` 对象，不是字段补丁；迁移失败时抛错。它没有 `context` 或 `services` 参数，不应修改宿主或远端状态。

例如旧结构的 `width` 改名为 `maxWidth`，以下是新版本描述中的方法片段：

```ts
async migrateConfig({ from, config }) {
  if (from.configSchemaVersion === 1) {
    const { width, ...rest } = config;
    return { ...rest, maxWidth: width ?? 1280 };
  }
  return config;
},
```

新 Schema 应声明 `maxWidth`，并将 `configSchemaVersion` 设为 `2`。迁移返回新配置，不直接修改已保存实例；宿主随后按目标 Schema 校验并展示预览，不补默认值。本例的 `1280` 由迁移函数显式提供。没有迁移函数时，沿用旧配置进行校验。

预览只执行 Schema 校验；确认保存时还会执行 `validateConfig`、本地目录解析、不可变字段及并发版本检查。预览无字段错误不代表一定能保存。已有不可变值在升级时仍受保护，新旧 Schema 都参与检查；原先缺失的不可变字段允许在升级时初始化。

迁移输入可能包含敏感配置，不要记录日志。迁移函数应只转换数据，不执行远端写入，也不能假定只调用一次。

旧实例的释放方式见 [实例生命周期](./plugin-errors.md#并发调用与实例生命周期)。

## 发布前验证

先构建并安装实际 ZIP，再验证创建配置实例和目标操作，不只在源码里直接调用函数。升级包还应验证旧配置的预览和应用结果。

插件可以通过 Release 附件等方式分发 ZIP，无需把自己的插件发布到 npm。
仓库示例的构建与验证命令见[插件工具维护](./plugin-tooling-maintenance.md#仓库示例)。

接口类型以 [SDK](https://github.com/llleixx/picloom-tooling/blob/main/plugin-sdk/api.ts) 为准。插件说明应写清支持的阶段、配置项、请求参数及外部服务要求。
