# 快速开始

用独立模板开发一个日期路径插件，构建 ZIP 并安装到 Picloom。插件项目通过
`@picloom/plugin-sdk` 获取类型和辅助函数，无需 clone 主仓库，也无需把插件发布到 npm。

::: warning 当前发布状态
SDK 和创建工具尚未发布到 npm。现在请获取维护者提供的两个 `.tgz`，按
[本地压缩包](#本地压缩包)创建项目，再继续本文第 3 步。
:::

## 1. 准备环境

- Bun 1.4.3+：创建、安装依赖、类型检查和打包均使用 Bun，不需要 Node.js 或 npm CLI。
- 一个可用的 Picloom 测试实例与 Owner 账号，用于安装插件和验证上传。
- 当前 SDK 0.1.0 对应 API 1，适配 Picloom 0.1.0 开发源码，不保证任意旧开发构建兼容。

SDK 不包含宿主服务。当前 Docker 镜像也尚未发布；没有测试实例时，可以请维护者提供
部署，或参考[本地开发](./contributing.md)搭建宿主。插件项目本身不需要宿主源码。

## 2. 创建项目

**以下 registry 命令在 npm 包发布后可用：**

```sh
bun create @picloom/plugin@0.1.0 ./my-plugin
cd my-plugin
bun install
```

创建工具只复制文件，不自动安装依赖。目标目录必须不存在，父目录必须存在。
首次安装后，将生成的 `bun.lock` 提交到自己的插件仓库。

```text
my-plugin/
├── plugin.json           # 插件身份和版本
├── src/index.ts          # 配置与业务实现
├── scripts/build.ts     # 类型检查之后的 ZIP 构建
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

在 `src/index.ts` 的 `content["en-US"].name` 中设置显示名称，例如 `My date path`。
名称、简介和字段文案按语言放入 `content`，`defaultLocale` 指定缺少翻译时的默认语言。
详见[多语言文案](./plugin-config.md#界面提示与翻译)。

模板已经能按 UTC 日期生成路径。打开 `src/index.ts`，可以在返回路径前加一段目录，
例如把 `logicalKey` 改为：

```ts
return { logicalKey: `albums/${date}/${fileId}.${extension}` };
```

先保留模板中的配置、格式检查和实例结构，完整接口随后查阅[路径插件](./plugin-path.md)。

## 4. 构建 ZIP

```sh
bun run build
```

构建先检查类型，再把 JavaScript 与依赖合并、检查清单和默认导出的一致性，输出：

```text
dist/example.my-date-path-0.1.0.zip
```

无需系统 `zip` 命令。单独检查类型可运行 `bun run typecheck`。
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

下一步按需求选择[存储插件](./plugin-storage.md)或[处理插件](./plugin-api.md)。
各教程直接展示仓库里的完整示例，可以复制页面中的代码，无需下载仓库。

把示例放入独立项目时：

1. 用示例实现替换 `src/index.ts`，将 `../../plugin-sdk` 改为 `@picloom/plugin-sdk`。
2. 在清单中设置对应 `kind`（路径 `path`、存储 `storage`、处理 `processor`），保留自己的
   ID 和版本；删除示例默认导出中写死的 `id/version/kind/apiVersion`。
   在入口的 `content` 中修改各语言的名称，保留示例的字段文案。
3. 从清单读取身份字段，并为 `kind/apiVersion` 做类型收窄。下面以存储插件为例，
   路径或处理插件把检查中的 `storage` 分别改为 `path` 或 `processor`：

```ts
import manifest from "../plugin.json";

const { kind, apiVersion } = manifest;
if (kind !== "storage" || apiVersion !== 1)
  throw new Error("Expected storage plugin API 1");

// 在示例默认导出中使用以下身份字段，其余配置和方法保持示例结构：
// id: manifest.id,
// version: manifest.version,
// kind,
// apiVersion,
```

使用对应的 `Definition<"storage">` 等类型，保持示例原有的其他 SDK 导入。
运行 `bun run build`，上传 `dist/<自己的ID>-<版本>.zip`，再按教程接入验证。
页面里的 **Example …** 是示例展示名，管理界面中应选择你自己设置的名称。

## 本地压缩包

当前未发布阶段，向维护者获取 `picloom-plugin-sdk-0.1.0.tgz` 和
`picloom-create-plugin-0.1.0.tgz`。把它们放在任意目录，替换下面的绝对路径：

```sh
mkdir plugin-tools
cd plugin-tools
bun add --dev /absolute/path/picloom-create-plugin-0.1.0.tgz
bun create @picloom/plugin ../my-plugin
cd ../my-plugin
```

将生成项目 `package.json` 中现有 SDK 开发依赖的值改为（其他依赖保持不变）：

```json
"@picloom/plugin-sdk": "file:/absolute/path/picloom-plugin-sdk-0.1.0.tgz"
```

执行 `bun install`，然后继续本文[修改插件](#_3-修改插件)。SDK 发布后可切回精确 registry
版本并更新锁文件。维护者如何生成这些文件见[插件工具维护](./plugin-tooling-maintenance.md#本地打包)。
