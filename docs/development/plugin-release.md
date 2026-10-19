# 打包、发布与升级

## ZIP 结构

```text
plugin.json
index.js
```

`plugin.json` 必须位于 ZIP 根目录，`entry` 指向包内 `.js` 文件。入口默认导出插件定义，清单与定义的 ID、版本、类型和 API 版本须一致。外部插件 ID 不能使用 `builtin.` 前缀。

ZIP 上传大小上限为 20 MiB。不要把源码目录整体压缩后嵌套在包内，也不要包含 `.env`、凭证或开发数据。

## 构建依赖

仓库示例的实际构建脚本如下：

<<< ../../examples/build.ts

使用 Bun 目标和 ESM 输出，将需要的 JavaScript 依赖随入口打包。仅声明依赖不会让 Picloom 安装时自动执行包管理器；也不要假设宿主具有任意第三方包。

图片处理使用 `services.images.sharp`，避免把另一套 Sharp 原生依赖打入包中。SDK 可随包打入，`PluginError` 使用结构协议识别，不依赖双方共享同一个类实例。

## 三种版本各管什么

| 字段 | 作用 | 何时修改 |
| --- | --- | --- |
| `apiVersion` | 插件与宿主的接口协议，当前为 `1` | 接入宿主支持的另一版协议时 |
| `version` | 插件代码版本 | 发布代码变更时 |
| `configSchemaVersion` | 配置结构版本；处理插件按阶段声明 | 配置结构变化时 |

同 ID、同版本不能覆盖安装。只修改代码也应发布新的插件版本；不改变配置结构时不必增加 `configSchemaVersion`。

## 升级配置实例

安装新包只提供新版本，不会自动切换所有实例：

1. 构建并安装新版本。
2. 编辑使用该插件的存储源、上传配置或流水线步骤。
3. 选择新版本，查看迁移预览，补齐或修正配置。
4. 应用升级并验证实际读写或处理结果。

## migrateConfig：转换旧配置

可选。宿主预览或应用版本升级时调用，位于路径/存储定义顶层，或处理插件的对应阶段描述中。

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

新 Schema 应声明 `maxWidth`，并将 `configSchemaVersion` 设为 `2`。迁移返回新配置，不直接修改已保存实例；宿主随后应用默认值、校验并展示预览。没有迁移函数时，沿用旧配置进行校验。

迁移输入可能包含敏感配置，不要记录日志。迁移函数应只转换数据，不执行远端写入，也不能假定只调用一次。

旧实例的释放方式见 [实例生命周期](./plugin-errors.md#并发调用与实例生命周期)。

## 发布前验证

先构建并安装实际 ZIP，再验证创建配置实例和目标操作，不只在源码里直接调用函数。升级包还应验证旧配置的预览和应用结果。

仓库五个示例的验证命令：

```sh
bun run build:examples
bun test tests/examples.test.ts
```

接口类型以 [SDK](https://github.com/llleixx/picloom/blob/main/plugin-sdk/api.ts) 为准。插件说明应写清支持的阶段、配置项、请求参数及外部服务要求。
