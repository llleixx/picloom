# 插件工具维护

本文面向 Picloom 三仓维护者。第三方插件作者从[快速开始](./plugin-tooling.md)进入，
不需要 clone 主仓库或构建 SDK。

## 源码与分发

| 目录 | 职责 | 分发产物 |
| --- | --- | --- |
| `plugin-sdk/` | 公共类型、错误与文件辅助函数 | `@picloom/plugin-sdk` |
| `tools/plugin-tools/` | 编译、检查和 ZIP 打包 | `@picloom/plugin-tools` |
| `tools/create-plugin/` | 创建入口与独立模板 | `@picloom/create-plugin` |
| `picloom/examples/` | 各类型的完整示例，供教程引用和宿主集成验证 | 示例 ZIP |

插件工具链使用 Bun 1.4.3+。主应用的 Vue 类型检查仍由 Node 执行；
不要对主应用的 `vue-tsc` 强制使用 Bun，这不影响独立插件项目。

## 本地打包

SDK、工具和脚手架位于独立的 `picloom-tooling` 仓库；上表前三行目录相对于该仓库。
主程序及官方扩展通过公共包入口使用 SDK，不直接引用工具链源码。

在相邻工具链仓库执行：

```sh
cd ../picloom-tooling
bun install --frozen-lockfile
bun run dev:sync -- ../picloom ../picloom-extensions
```

同步命令构建并生成带内容哈希的 `.tgz`，复制到消费仓库的 `.local-packages/`，
更新对应 `package.json` 并运行 `bun install`。每次修改工具链后重新同步；无需删除锁文件或发布包。
可单独运行 `bun run build` 后，在各包目录执行 `bun pm pack --ignore-scripts`，供独立作者验证。
压缩包忽略于 Git；仅在源码联调时临时使用。提交或分发前应切回已发布的精确版本并更新锁文件。

## 独立项目验证

```sh
bun run test:plugin-tooling
```

以上检查从 `picloom` 主仓库运行，默认打包相邻的 `picloom-tooling`；其他路径通过 `PICLOOM_TOOLING_DIR` 指定。
该显式检查需要 Bun 和依赖下载网络，子进程的 PATH 仅包含 Bun，确认找不到 Node/npm。
使用 `bun pm pack` 将三个包打成真实 `.tgz`，在系统临时
目录安装创建工具，通过 `bun create` 生成独立项目并安装 SDK 和开发工具压缩包，验证类型、ZIP 和隔离宿主安装、
上传与图片处理。普通 `bun test ./tests` 不默认执行这个网络依赖验证。

## npm 发布流程

本地包验证完成不等于 registry 发布成功。发布由维护者明确执行，不配置自动发布。
发布顺序为 SDK 与开发工具 → 创建工具；创建工具中的模板必须引用已发布且验证过的 SDK。
发布前检查 `bun pm pack --dry-run` 文件清单，发布后再从 registry 验证创建与构建流程。
npm 可能在接收上传后继续扫描；命令成功不代表版本已可下载。等待 registry 提供目标版本后，
使用全新目录创建项目、安装依赖并构建，确认未引用本地压缩包。

本地打包后可把三个 `.tgz` 交给插件作者，按[本地压缩包创建项目](./plugin-tooling.md#本地压缩包)使用。

## 仓库示例

需要 Bun，不需要系统 `zip`；安装验证使用隔离的 Picloom 测试实例。在终端执行：

```sh
git clone https://github.com/llleixx/picloom.git
cd picloom
bun install --frozen-lockfile
bun run build:examples
bun test tests/examples.test.ts
```

每个示例目录都有 `plugin.json`（清单）和 `src/index.ts`（实现）。脚本将 TypeScript 和 SDK 引用打包成 JavaScript，生成可安装的 ZIP：

| 教程 | 源码目录 | `outputs/examples/` 下的产物 |
| --- | --- | --- |
| [路径插件](./plugin-path.md) | `examples/path` | `path.zip` |
| [存储插件](./plugin-storage.md) | `examples/storage` | `storage.zip` |
| [上传处理](./processors/upload.md) | `examples/processor` | `processor.zip` |
| [访问处理](./processors/access.md) | `examples/access` | `access.zip` |
| [保存后处理](./processors/post-save.md) | `examples/post-save` | `post-save.zip` |

选择一个教程即可，不需要一次安装所有示例。各教程先解释职责和一次调用，再列出必需、可选接口及输入输出，最后给出完整实现和验证步骤。第一次开发建议从路径插件开始。

修改已安装的仓库示例后，需要同步增加清单和入口中的版本；独立模板的入口直接读取
清单，只需修改清单版本。再安装并应用升级，同 ID、同版本不能覆盖。
详见 [打包与升级](./plugin-release.md)。

## 更新时保持一致

修改公共接口时同步 SDK 类型、相应教程和示例；修改模板时检查生成项目的 README。
模板固定一个已验证的 SDK 版本；发布 SDK 后再更新并发布引用它的创建工具。
兼容范围维护在 SDK README，首次安装由插件作者生成并提交自己的 `bun.lock`。

仓库示例的构建脚本如下；它只调用统一工具 CLI 并汇总产物；独立模板也调用同一工具包：

<<< ../../examples/build.ts

SDK 构建会先清空生成目录 `dist/`，再生成运行时代码与类型声明，避免已经删除的模块声明残留在发布包中。

常规开发使用 npm 精确版本：工具 0.1.0、脚手架 0.1.1、插件 SDK 0.1.0。
