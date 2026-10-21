# Picloom theme / 主题开发

Requires Bun 1.4.3+. This project starts from Picloom's built-in default theme,
uses only the public Theme SDK, and bundles its own Vue runtime.

```sh
bun install
bun run dev
bun run typecheck
bun run build
bun run preview
```

`dev` listens on http://127.0.0.1:5173; use `bun run dev --port 5174` if occupied.
The collapsible preview panel switches pages, languages, appearance, identity and
simulated states. Uploads and login are **simulations**, never real API calls.
Do not use preview success as evidence that a storage service or authentication works.

Edit `src/Page.vue`, `src/style.css` and `theme.json`. All pages use `src/entry.ts`
(`entry.js` in the package). Put static package resources in `public/assets/` and
resolve them with `context.asset("assets/...")`. Imported image/CSS resources are
also processed by Vite. Keep `style.css` in the manifest's global `styles`: it
contains all CSS imported by the source entry. Additional page-only styles belong
in `public/assets/` and the corresponding page's `styles`; preview loads and
unloads them when changing pages. Arbitrary files outside these inputs are not packaged.

Vue components and CSS support HMR. Entry changes reload the preview. Manifest
and `dev/config.json` changes reload and remount the theme. Invalid JSON shows a
development error and is never overwritten. The first preview initializes a
missing config from schema defaults; later edits never restore removed values.
There is initially no custom config schema, so the generated config is `{}`.

`preview` loads the existing `dist/package/` JavaScript and styles through the
same simulated host, without theme source HMR. Build first; source edits are not
visible until you rebuild. The preview toolbar itself is still a local tool.

The distributable is `dist/<theme-id>-<version>.zip`. Upload it to Picloom's Themes
page, confirm trust, preview and apply. Test real uploads, login and permissions
there. Increase `theme.json.version` before distributing changed content; package
versions are immutable on the host. The package builder checks structure and
resources; full configuration/manifest validation still runs on installation.

The SDK dependency is pinned to a published npm version.
Commit your generated `bun.lock` to your own repository after installation.

## 中文

- 使用 Bun 1.4.3+，无需 Node/npm CLI、主仓库或系统 `zip`。
- `bun run dev` 提供模拟首页、登录页、上传状态、语言和明暗模式；只用于界面开发。
- 修改 Vue 组件及样式会热更新；入口、清单和本地配置修改后刷新预览。
- 首次启动时按 Schema 默认值创建 `dev/config.json`，之后清空或删除值不会自动补回。
- `bun run build` 先检查类型，再构建并生成可安装 ZIP；`bun run preview` 检查已有构建产物。
- 修改主题 ID、显示名称和版本均以 `theme.json` 为准，静态资源放入 `public/assets/`。
- 入口导入的样式合并为 `style.css`，须保留清单全局样式声明；页面专属样式通过各页面的 `styles` 引用，切页时分别加载和卸载。
- 主题包不包含开发面板、本地配置、凭据或源码映射。所有主题配置可能公开，不要保存密钥。
- 在隔离 Picloom 测试实例安装 ZIP 后验证真实上传和登录；模拟成功不代表真实服务已验证。
- SDK 依赖固定到 npm 版本；首次安装后将生成的 `bun.lock` 提交到自己的仓库。
