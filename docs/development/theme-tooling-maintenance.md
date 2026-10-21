# 主题工具维护

默认主题源码位于 `themes/default/`，宿主通过薄适配层加载它。创建工具构建时复制同一份源码，
并将现有纯共享辅助函数打包进私有开发工具；不手工修改 `tools/create-theme/dist/template/`。
SDK 根入口不提供模拟器或服务端运行时。Horizon 是进阶示例。

在仓库根目录生成本地包：

```sh
bun run build:create-theme
mkdir -p outputs/npm
cd theme-sdk
bun pm pack --ignore-scripts --destination ../outputs/npm
cd ../tools/create-theme
bun pm pack --ignore-scripts --destination ../../outputs/npm
cd ../..
```

显式执行 `bun run test:theme-tooling` 验证真实 `.tgz`、仓库外创建、Bun-only 工具路径、
预览和宿主安装。此检查会下载依赖，普通后端测试默认跳过。
本地打包不是发布；不自动发布 npm 包或镜像。
维护者发布时先发布 `@picloom/theme-sdk`，再发布 `@picloom/create-theme`。
等待 npm 扫描完成、registry 提供目标版本后，在全新目录通过 npm 创建项目、安装依赖并构建。
发布命令成功不能代替这项下载验证。

## 仓库示例

在仓库根目录运行：

```sh
bun run build:themes
```

需要 Linux `zip` 命令。生成 `outputs/themes/horizon.zip`，在隔离的开发站点安装并预览即可。独立项目请使用[主题开发脚手架](./theme-tooling.md)，模板与宿主共用 `themes/default/` 的默认主题源码。脚手架打包使用 JavaScript ZIP 库，不需要系统 `zip`。

`examples/themes/horizon` 是「Horizon · 远空」完整主题：内置四张二次元风景插画、全屏淡入淡出轮换、半透明上传与登录面板、移动布局和双语文案。后台可配置标题、说明、轮换间隔、遮罩与可增删、排序的背景图片列表（图片地址、双语名称和配色），详见该目录的 README。

修改示例后重新构建，使用新的 `version` 安装；同 ID、同版本不能覆盖，避免不可变资源缓存返回旧文件。开发时也可卸载未启用的测试版本后重新安装，但不要以相同版本替换已对外分发的不同内容。

示例入口自行打包 Vue；不要引用 `web/src`、宿主组件或共享 Vue 实例。类型从 `theme-sdk/index.ts` 导入，独立项目可安装本地 `theme-sdk` 包并从 `@picloom/theme-sdk` 导入类型。包只提供类型，运行时能力由宿主注入。
