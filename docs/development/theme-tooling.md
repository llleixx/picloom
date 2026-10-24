# 主题快速开始

使用 Bun 1.4.4+ 创建独立 Vue 3 主题，默认模板由独立的 `picloom-tooling` 仓库维护。
无需 clone 主仓库、Node/npm CLI 或系统 `zip`。完整协议见[主题协议](./themes.md)。

## 创建与开发

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
| `src/entry.ts` | 公开 `mount` 入口；卸载时返回并调用 `dispose` |
| `src/Page.vue`、`src/style.css` | 默认首页、登录页和自包含样式 |
| `public/assets/` | 通过 `context.asset()` 读取的包内静态资源 |
| `dev/config.json` | 首次启动预览时自动生成的本地配置 |
| `vite.config.ts` | 主题自己的 Vite 与框架插件配置 |
| `package.json` | 调用 `@picloom/theme-tools` 的开发、构建和预览命令 |

先修改 ID 和 `messages` 中的显示名称。主题版本以 `theme.json.version` 为准，
`package.json.version` 不决定安装版本。默认模板没有自定义配置字段，配置为 `{}`。

## 模拟预览与热更新

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

## 配置与资源

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

## 构建、安装与验证

```sh
bun run typecheck
bun run build
bun run preview
```

类型检查使用独立命令 `bun run typecheck`。构建将 Vue 和依赖合并成浏览器模块，输出 `dist/package/` 与
`dist/<主题ID>-<版本>.zip`。`preview` 使用同一模拟宿主加载已构建 JavaScript 和样式，
不使用主题源码热更新；修改源码后须重新构建。工具只做基本声明、资源与产物检查，
宿主安装负责完整清单与配置校验。

ZIP 根目录直接包含 `theme.json`。上限为 20 MiB 压缩、50 MiB 解压、512 个条目，
构建拒绝资源冲突、越界路径、符号链接、未打包依赖和开发引用。路径规则与宿主共用，允许合法中文文件名，不接受空格等宿主不支持的路径。
只打包生产构建及显式资源，不包含 `dev/`、本地配置、凭据或源码映射。
不要把凭据放进源码或静态资源；主题包资源可公开访问。

将 ZIP 上传至隔离测试实例，确认信任并安装，预览后应用。分别验证真实上传、登录、权限和移动布局。
修改分发内容时增加主题版本；同 ID、同版本不能覆盖。
