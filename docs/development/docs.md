# 文档站维护

文档站使用 VitePress，与应用同仓库维护。Markdown 页面、导航和示例共同构成文档；依赖单独安装在 `docs/`，不进入应用 Docker 构建。

## 文件放在哪里

| 位置 | 内容 |
| --- | --- |
| `docs/guide/` | 用户概念与使用流程 |
| `docs/operations/` | 部署、数据与运行维护 |
| `docs/development/` | 插件开发与核心开发 |
| `docs/reference/` | 配置等参考信息 |
| `docs/.vitepress/zh.ts` | 中文导航、侧栏和首页配置 |
| `docs/.vitepress/config.mts` | 站点路径、多语言、搜索与 Mermaid 配置 |
| `docs/.vitepress/theme/` | 主题样式与扩展 |
| `docs/public/` | 图标等静态文件 |
| `docs/package.json`、`docs/bun.lock` | 独立依赖与锁文件 |
| `.github/workflows/docs.yml` | GitHub Pages 构建与发布 |

`docs/dev/` 被排除在站点之外，不作为公开文档来源。

## 本地修改与预览

在仓库根目录执行：

```sh
bun install --cwd docs --frozen-lockfile
bun run docs:dev
```

新增页面后，在 `zh.ts` 中加入侧栏入口。正文使用相对 Markdown 链接，例如 `[本地开发](./contributing.md)`；改标题时检查指向旧标题锚点的链接。

完成后验证构建与预览：

```sh
DOCS_BASE=/picloom/ bun run docs:build
DOCS_BASE=/picloom/ bun run docs:preview
```

在预览输出的地址后加上 `/picloom/`。构建检查页面链接；还需打开改动页面，检查标题跳转、表格、流程图和代码展示。构建成功不代表示例命令或所有锚点正确。

## 示例与流程图

接口字段、配置名称和默认值以代码为准。优先引用仓库中可运行的示例，如在 `docs/development/` 的页面引用路径插件：

```md
<<< ../../examples/path/index.ts
```

引用会随源码更新，但仍需解释输入、输出和调用时机。修改插件示例时执行：

```sh
bun run build:examples
bun test tests/examples.test.ts
```

流程图直接写成 Mermaid，便于随正文维护：

````md
```mermaid
flowchart LR
  request[请求] --> core[核心服务] --> plugin[插件]
```
````

使用项目现有图标，保持 `docs/public/picloom.svg` 与 `web/public/assets/picloom.svg` 一致。

## 发布到 GitHub Pages

先将 `.github/workflows/docs.yml` 提交到仓库，并在 **Settings → Pages → Build and deployment** 将 Source 设为 **GitHub Actions**。

工作流在文档、插件示例、SDK 或工作流文件变更时触发：PR 只构建，`main` 分支构建后发布，也支持手动触发。默认站点路径为 `/<仓库名>/`，本仓库为 `/picloom/`。

独立域名或 `<用户>.github.io` 仓库应在 Actions variables 中设置 `DOCS_BASE=/`。独立域名还需在 Pages 设置中完成域名与 DNS 配置；本地验证时使用同样的 `DOCS_BASE`。

## 增加语言

中文位于根路径。新增英文时：

1. 在 `docs/en/` 建立对应页面，路径尽量镜像中文结构。
2. 增加英文导航配置，链接指向 `/en/` 下的页面。
3. 在 `config.mts` 的 `locales` 增加 `en`，设置 `link: '/en/'`、`lang: 'en-US'`，补齐搜索界面翻译。

翻译完成前不开放空语言入口。插件的 `content` 与文档站语言配置相互独立。

## 内容约定

先解释对象和流程，再说明如何操作；开发接口应明确必需与可选能力、输入和输出。示例标明需要替换的值，不使用真实凭证或用户数据。

一条规则只在一处完整解释，其他页面链接过去。文字修改只验证文档；示例、命令或行为变化时，再运行对应的必要验证。
