# 快速开始

用独立模板开发一个日期路径插件，构建 ZIP 并安装到 Picloom。插件项目通过
`@picloom/plugin-sdk` 获取类型和辅助函数，无需 clone 主仓库，也无需把插件发布到 npm。

## 1. 准备环境

- Bun 1.4.4+：创建、安装依赖、类型检查和打包均使用 Bun，不需要 Node.js 或 npm CLI。
- 一个可用的 Picloom 测试实例与 Owner 账号，用于安装插件和验证上传。

SDK 不包含宿主服务。没有测试实例时，可按[Docker 快速开始](../guide/quick-start.md)部署隔离实例，或参考[本地开发](./contributing.md)从源码启动。插件项目本身不需要宿主源码。

## 2. 创建项目

```sh
bun create @picloom/plugin@0.1.3 ./my-plugin
cd my-plugin
bun install
```

创建工具只复制文件，不自动安装依赖。目标目录必须不存在，父目录必须存在。

```text
my-plugin/
├── plugin.json           # 插件身份和版本
├── src/index.ts          # 配置与业务实现
├── package.json         # 开发依赖和命令
├── tsconfig.json
└── README.md
```

## 3. 修改插件

先修改 `plugin.json` 中的 `id`，例如：

```json
{
  "id": "example.my-date-path",
  "version": "0.1.0",
  "kind": "path",
  "apiVersion": 1,
  "entry": "index.js"
}
```

这里的 `example.*` 只是练习用 ID，分发前换成自己的稳定标识。入口直接读取清单中的
身份字段，不需要再改一份版本号；`package.json` 的版本不是插件版本。

在 `src/index.ts` 的 `messages["en-US"][nameKey]` 中设置显示名称，例如 `My date path`。
名称、简介和字段文案按语言放入 `messages`，`defaultLocale` 指定缺少翻译时的默认语言。
详见[多语言文案](./package-localization.md#表单提示)。

模板已经能按 UTC 日期生成路径。打开 `src/index.ts`，可以在返回路径前加一段目录，
例如把 `logicalKey` 改为：

```ts
return { logicalKey: `albums/${date}/${fileId}.${extension}` };
```

先保留模板中的配置、格式检查和实例结构，完整接口随后查阅[路径插件](./plugin-path.md)。

## 4. 构建 ZIP

```sh
bun run typecheck
bun run build
```

类型检查单独执行 `bun run typecheck`。构建由 `@picloom/plugin-tools` 把 JavaScript 与依赖合并、检查清单和默认导出的一致性，输出：

```text
dist/example.my-date-path-0.1.0.zip
```

构建会加载自己的插件入口，因此不要在模块顶层执行网络请求等副作用。
依赖、额外资源和大小限制见[打包与升级](./plugin-release.md)。

## 5. 安装并验证

1. 以 Owner 登录测试实例，在插件管理中上传 ZIP，确认信任并安装，检查加载状态。
2. 创建一个测试上传配置，选择 **My date path**，关联可用存储组，公开前缀设为 `/photos/`。
3. 使用该上传配置上传一张 PNG，确认返回路径类似
   `/photos/albums/2026/10/20/<文件ID>.png`，日期应为上传当天的 UTC 日期。
4. 打开返回链接，确认图片可以读取。

安装包只提供插件代码，接入配置后才会被调用。包、定义和实例的区别见[插件基础](./plugin-start.md)。
修改代码后，增加清单版本、重新构建并安装，再按[升级配置实例](./plugin-release.md#升级配置实例)
选择新版本。安装新版不会自动切换已有实例。

## 使用教程示例

按需求选择[路径](./plugin-path.md)、[存储](./plugin-storage.md)、[上传处理](./processors/upload.md)、[访问处理](./processors/access.md)或[保存后处理](./processors/post-save.md)。

每篇提供独立项目的完整导入和清单外层，以及从仓库示例引用的实现片段。按页面指定的 `kind` 更新清单，用实现片段替换外层代码的注释行即可；ID 和版本由清单读取。配置字段及运行方法与仓库示例使用同一来源。
