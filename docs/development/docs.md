# 维护文档站

文档使用 VitePress，源码与应用同仓库，依赖和锁文件独立放在 `docs/`。不进入应用的 Docker 构建。

## 本地预览

在仓库根目录执行：

```sh
bun install --cwd docs --frozen-lockfile
bun run docs:dev
```

构建与预览：

```sh
bun run docs:build
bun run docs:preview
```

构建会检查站内页面链接。涉及 SDK 示例时，同时执行 `bun run build:examples`。

## GitHub Pages

工作流位于 `.github/workflows/docs.yml`。在 GitHub 仓库的 **Settings → Pages → Build and deployment** 中，将 Source 设为 **GitHub Actions**。

PR 构建校验，主分支更新后发布；也可手动触发工作流。默认路径为 `/<仓库名>/`，例如本仓库为 `/picloom/`。

绑定独立域名后，在仓库 Actions variables 中设置 `DOCS_BASE=/`，并在 Pages 设置里完成域名与 DNS 配置。若仓库名本身为 `<用户>.github.io`，也应设置 `DOCS_BASE=/`。

本地验证仓库子路径：

```sh
DOCS_BASE=/picloom/ bun run docs:build
DOCS_BASE=/picloom/ bun run docs:preview
```

## 增加语言

中文内容使用根目录路径，中文导航和界面文字位于 `.vitepress/zh.ts`。

增加英文时：在 `docs/en/` 放置对应页面，新建英文导航配置，再向 `.vitepress/config.mts` 的 `locales` 增加 `en` 项并设置 `link: '/en/'`、`lang: 'en-US'`。页面路径尽量镜像中文结构，搜索翻译在同一配置中补齐。

翻译完成前不要放出空白语言入口。插件自身的 `translations` 与文档站语言配置是两个独立接口。

## 写作规则

- 使用教程写清操作入口、必填值和完成后的验证方法；字段使用界面中的名称。
- 给出可照做的最小示例，说明值从哪里取得、哪些需要替换。接口示例同时给出请求和响应。
- 概念用具体场景解释；内部类型名和状态机放到开发者文档。避免只有功能概述而没有操作步骤。
- 规则只在一处完整解释，其余页面链接过去。
- 示例优先引用真实源码；不要使用真实凭证、个人域名或用户数据截图。
- 行为变化时同步更新文档。当前只维护一套开发版本文档，不复制多版本目录。

文档站使用项目原有图标，`docs/public/picloom.svg` 与 `web/src/assets/picloom.svg` 保持一致；更新图标时同步这两个文件。
