# 主题快速开始

使用 Vue 3 模板创建主题，在本地预览后构建 ZIP 并安装到 Picloom。

## 准备环境

- Bun 1.4.4+，用于创建项目、运行预览和构建。
- 一个 Picloom 测试实例和 Owner 账号，用于安装与验证。

## 创建项目

```sh
bun create @picloom/theme@0.1.3 ./my-theme
cd my-theme
bun install
bun run dev
```

目标目录必须不存在，父目录必须存在。

| 路径 | 用途 |
| --- | --- |
| `theme.json` | 主题 ID、版本、页面、翻译与可选配置 Schema |
| `src/entry.ts` | 导出 `mount`，返回供宿主卸载时调用的 `dispose` |
| `src/Page.vue`、`src/style.css` | 默认首页、登录页和自包含样式 |
| `public/assets/` | 通过 `context.asset()` 读取的包内静态资源 |
| `dev/config.json` | 首次启动预览时自动生成的本地配置 |
| `vite.config.ts` | 主题自己的 Vite 与框架插件配置 |
| `package.json` | 调用 `@picloom/theme-tools` 的开发、构建和预览命令 |

## 修改项目

在 `theme.json` 修改 ID 和 `messages` 中的显示名称。主题版本以 `theme.json.version` 为准，
`package.json.version` 不决定安装版本。默认模板没有自定义配置字段，配置为 `{}`。

### 模拟预览与热更新

默认地址 `http://127.0.0.1:5173/`，端口占用时报错，可运行：

```sh
bun run dev --port 5174
```

右下角可收起面板提供首页／登录页、语言、外观、身份及加载中、上传中、成功、失败、
无方案、登录失败等场景。它通过公共 `ThemeContext` 挂载主题，与主题样式隔离。
文件只生成模拟记录，不上传；模拟登录不保存密码；复制使用浏览器剪贴板。
预览不连接 Picloom 实例。

组件与 CSS 使用热更新；入口、清单或配置变化重新挂载或刷新。
首次启动时将 Schema 默认值写入缺失的 `dev/config.json`，之后读取实际值，不补回清空的内容。
无效 JSON 显示开发错误，不覆盖原文件。重新挂载先销毁旧实例；自行创建的监听器和定时器必须在 `dispose` 中清理。

### 配置与资源

在清单增加多语言配置字段的例子：

```json
{
  "configSchema": {
    "type": "object",
    "properties": {
      "heading": {
        "type": "string",
        "x-localized": true,
        "x-ui": { "labelKey": "heading.label" },
        "default": { "en-US": "Welcome", "zh-CN": "欢迎" }
      }
    }
  }
}
```

同时在清单 `messages` 的默认语言字典中添加 `heading.label`，其他语言按需翻译。
如果本地配置已经存在，新默认值不会补入其中；请手动编辑 `dev/config.json`。
组件中通过 `context.localized(context.config.heading)` 读取，不跨语言回退。
列表配置可参考 Horizon 的 `backgrounds`：对象列表包含图片地址、双语名称与配色。

静态图片放入 `public/assets/background.webp`，通过 `context.asset("assets/background.webp")`
读取。入口导入的样式统一构建为 `style.css`，必须在清单全局 `styles` 中保留。
其他页面专属样式放入 `public/assets/`，通过对应页面的 `styles` 引用；源码与生产预览均随切页加载和卸载。
不要引用宿主组件、共享 Vue 实例或仓库相对路径。SDK 根入口仅提供类型，运行时由宿主注入；本地预览和 ZIP 构建由 `@picloom/theme-tools` 统一提供。

## 构建 ZIP

```sh
bun run typecheck
bun run build
bun run preview
```

构建输出 `dist/<主题ID>-<版本>.zip`。用 `bun run preview` 在模拟宿主中检查已构建的 JavaScript 和样式。修改源码后需重新构建。清单、入口和资源约束见[主题协议](./themes.md#主题包)。

## 安装与验证

1. 以 Owner 登录测试实例，在主题管理中上传 ZIP，确认信任并安装。
2. 打开主题预览，检查已声明页面的样式、语言和配置，再应用主题。
3. 打开已应用的页面。主题提供首页时，实际上传一张图片并打开生成的链接；提供登录页时，用测试账号验证登录。

重新分发前增加 `theme.json.version`，同 ID、同版本不能覆盖安装。
