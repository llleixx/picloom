# 主题工具维护

## 源码与分发

工具链源码位于独立的 `picloom-tooling` 仓库。宿主默认主题仍在 `picloom/themes/default/`；
脚手架独立维护 `tools/create-theme/template/`，构建不再读取宿主默认主题。
预览、构建与 ZIP 打包由 `@picloom/theme-tools` 提供，公共纯规则由 `@picloom/package-rules` 维护并打入工具。
主题 SDK 仍为纯浏览器类型，不引入插件 SDK 或服务端运行时。

## 本地打包

修改工具链后，在工具链仓库临时同步本地依赖：

```sh
cd ../picloom-tooling
bun install --frozen-lockfile
bun run dev:sync -- ../picloom ../picloom-extensions
```

命令生成带内容哈希的压缩包，更新消费仓库的依赖与锁文件，不发布。
修改工具链后重新同步；也可指定生成的独立主题目录为目标。
模板源文件可以编辑，不手工修改 `tools/create-theme/dist/template/`。

## 独立项目验证

从主仓库执行 `bun run test:theme-tooling`，验证真实 `.tgz`、仓库外创建、Bun-only 工具路径、
预览和宿主安装。默认使用相邻的工具链目录，也可通过 `PICLOOM_TOOLING_DIR` 指定。
此检查需要依赖下载网络和 Playwright Chromium，普通后端测试默认跳过。

## npm 发布流程

主题工具和插件工具采用相同的[发布与验证流程](./plugin-tooling-maintenance.md#npm-发布流程)。先发布主题 SDK 与打包工具，再发布主题创建工具。

## 官方外部主题

Horizon 的配置、开发命令和素材来源见[主题说明](https://github.com/llleixx/picloom-extensions/blob/main/themes/horizon/README.md)。独立项目从[主题快速开始](./theme-tooling.md)创建。
