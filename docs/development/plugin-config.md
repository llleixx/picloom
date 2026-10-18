# 配置、密钥与版本

## 配置表单

插件用 `configSchema` 描述持久配置，核心验证并生成编辑界面。处理阶段可额外声明 `paramsSchema`，描述单次请求允许传入的标量参数。

当前仅支持项目约定的 JSON Schema 子集，不要假设所有 JSON Schema 关键字都可使用。约束实现在 [`shared/config.ts`](https://github.com/llleixx/picloom/blob/main/shared/config.ts) 和 [`shared/params-schema.ts`](https://github.com/llleixx/picloom/blob/main/shared/params-schema.ts)。

常用扩展：

| 字段                | 作用                               |
| ------------------- | ---------------------------------- |
| `x-sensitive: true` | 敏感配置，按密钥处理               |
| `x-immutable: true` | 创建后不可直接修改                 |
| `uiHints`           | 字段分组、顺序、输入样式和显示条件 |
| `translations`      | 插件名称、字段标题和说明的语言映射 |

翻译改变显示文字，不改变字段名或枚举值。可使用 `zh-CN` 等语言键。

## 密钥和运行状态

普通配置从 `createInstance({ config })` 获取；敏感值通过 `services.readSecrets()` 获取，不要假设它们存在于普通配置里。

`readSecrets` / `updateSecrets` 和 `readState` / `updateState` 都使用版本号。更新传入读到的版本，冲突后重新读取再决定是否更新，避免覆盖别的调用。

日志中不要输出配置对象、凭证、带密钥的 URL 或完整上游响应。密钥依赖部署的 `ENCRYPTION_KEY` 加密保存。

## 升级

`version` 标识插件代码版本；`configSchemaVersion` 标识配置结构版本，作用不同。

配置结构变化时实现 `migrateConfig`，从旧结构生成新配置。界面先做升级预览，再保存实例配置；安装新包不会自动切换所有实例。

旧实例仍被调用时，宿主通过引用计数延后释放。插件应正确实现 `dispose`，不要假定保存配置会立即终止所有旧调用。

## 本地目录声明

本地存储插件通过 `localDirectory: { configPath: "/root" }` 声明目录字段，供容量统计和备份识别。核心不应靠插件 ID 猜测目录。

本地目录配置也接受相对路径，以应用数据目录为基准。宿主在保存前将其转换为绝对路径，插件运行和备份使用同一已解析路径。
