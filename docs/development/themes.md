# 主题协议

主题以浏览器 ESM 模块替换首页或登录页，通过宿主注入的 `ThemeContext` 读取状态、执行上传和登录。首次开发先完成[主题快速开始](./theme-tooling.md)。

## 主题包

ZIP 根目录必须直接包含 `theme.json`，不要多包一层目录：

```json
{
  "id": "example.my-theme",
  "defaultLocale": "en-US",
  "nameKey": "package.name",
  "version": "1.0.0",
  "apiVersion": 1,
  "supportedLocales": ["zh-CN", "en-US"],
  "messages": {
    "zh-CN": { "package.name": "我的主题", "accent.label": "主色" },
    "en-US": { "package.name": "My theme", "accent.label": "Accent color" }
  },
  "pages": {
    "home": { "entry": "entry.js" },
    "login": { "entry": "entry.js" }
  },
  "styles": ["style.css"],
  "configSchema": {
    "type": "object",
    "properties": {
      "accent": {
        "type": "string",
        "default": "#286456",
        "x-ui": { "labelKey": "accent.label" }
      }
    }
  }
}
```

### 清单字段

| 字段 | 类型 | 必填 | 约束与用途 |
| --- | --- | --- | --- |
| `id` | `string` | 是 | 主题标识，外部主题不能以 `builtin.` 开头 |
| `version` | `string` | 是 | 包版本，分发内容变化时增加版本 |
| `apiVersion` | `1` | 是 | 宿主接口版本 |
| `nameKey` | `string` | 是 | 主题名称翻译键，默认语言须提供非空名称 |
| `author` | `string` | 否 | 作者，最多 200 字符，去除首尾空白后须非空 |
| `defaultLocale` | `Locale` | 是 | 包文案的回退语言，必须在 `supportedLocales` 中 |
| `supportedLocales` | `Locale[]` | 是 | 宿主支持的语言代码，至少一项且不可重复 |
| `messages` | `Record<Locale, Record<string, string>>` | 是 | 主题名称、界面和字段文案 |
| `pages` | `Partial<Record<Page, { entry: string; styles?: string[] }>>` | 是 | 至少声明 `home` 或 `login`。每页的 `entry` 必填，为包内 `.js` 或 `.mjs` 路径；`styles` 为可选的页面样式路径列表 |
| `styles` | `string[]` | 否 | 包内公共 `.css` 文件路径 |
| `preview` | `string` | 否 | 包内 PNG、JPEG 或 WebP 预览图路径 |
| `configSchema` | `Field & { type: "object" }` | 否 | 后台配置表单，省略时只接受空配置 `{}` |

`id` 和 `version` 均为 1–100 个字符，以英文字母或数字开头，可含点、下划线和短横线，且不能以点结尾。同 ID、同版本不能覆盖安装。

入口、样式和预览图须指向包内已有文件。ZIP 上限为 20 MiB、解压后 50 MiB、最多 512 项。入口使用浏览器 ESM，框架和依赖随主题打包。包内资源可公开访问。

## 生命周期与能力

### mount：挂载与清理

宿主传入渲染容器和 `ThemeContext`。导出 `mount`，同步或异步返回 `{ dispose(): void }`。离开页面时，宿主调用 `dispose()`，主题在此取消订阅、移除监听器并卸载框架实例。

```ts
import type { ThemeContext } from "@picloom/theme-sdk";

export function mount(container: HTMLElement, ctx: ThemeContext) {
  const unsubscribe = ctx.subscribe((state) => {
    container.textContent = state.site.name;
  });
  return {
    dispose() {
      unsubscribe();
      container.replaceChildren();
    },
  };
}
```

### ThemeContext：状态与页面操作

| 成员 | 签名或类型 | 用途 |
| --- | --- | --- |
| `apiVersion` | `1` | 宿主接口版本 |
| `config` | `Config` | 本次挂载的配置对象 |
| `getSnapshot` | `() => Snapshot` | 获取当前状态 |
| `subscribe` | `(listener: (snapshot: Snapshot) => void) => () => void` | 立即传入一次快照，之后在状态变化时调用。返回取消订阅函数 |
| `asset` | `(path: string) => string` | 用未编码的包内相对路径取得资源 URL |
| `t` | `(key: string, params?: Record<string, string \| number>) => string` | 读取包文案并替换参数 |
| `localized` | `(value: Json \| undefined) => string` | 读取配置中的当前语言文本 |
| `setLocale` | `(locale: Locale) => void` | 切换至快照允许的语言 |
| `setMode` | `(mode: Snapshot["mode"]) => void` | 设置 `light`、`dark` 或 `auto` |
| `navigate` | `(page: Page \| "app") => void` | 跳转到首页、登录页或后台 |
| `selectProfile` | `(id: string) => void` | 选择上传配置 |
| `refresh` | `() => Promise<void>` | 刷新宿主状态 |
| `login` | `(username: string, password: string) => Promise<void>` | 提交登录，在快照的 `login` 中读取忙碌和错误状态 |
| `organization` | 见下表 | 管理当前用户的上传归类 |
| `uploads` | 见下表 | 操作上传队列 |
| `links` | 见下表 | 格式化和复制图片链接 |

`Snapshot` 的字段定义由 `@picloom/theme-sdk` 导出。用快照渲染界面，通过下列方法提交操作。

| 方法 | 签名 | 用途 |
| --- | --- | --- |
| `organization.list` | `(kind: OrganizationKind, query?: { q?: string; limit?: number; offset?: number }) => Promise<{ items: OrganizationItem[]; total: number }>` | 搜索和分页读取归类 |
| `organization.create` | `(kind: OrganizationKind, name: string) => Promise<OrganizationItem>` | 创建分类，返回 `{ id, name }` |
| `organization.select` | `(selection: OrganizationSelection) => void` | 设置下一批上传的 `tagIds` 和 `collectionIds` |
| `uploads.add` | `(files: File[]) => void` | 将本地文件加入队列 |
| `uploads.addUrls` | `(urls: string[]) => void` | 将远程图片 URL 加入队列 |
| `uploads.cancel` | `(id: string) => Promise<void>` | 取消指定队列项 |
| `uploads.resume` | `(id: string) => void` | 恢复指定的可续传项 |
| `uploads.dismiss` | `(id: string) => Promise<void>` | 移除指定队列项 |
| `links.format` | `(url: string) => string` | 按当前偏好格式化链接 |
| `links.copy` | `(url: string) => Promise<void>` | 复制指定链接 |
| `links.copyAll` | `() => Promise<void>` | 复制队列中的成功结果 |
| `links.setPreferences` | `(format: string, auto: boolean) => void` | 设置链接格式和自动复制偏好 |

`OrganizationKind` 为 `"tags" | "collections"`。`list` 的 `limit` 默认 50、范围 1–100，`offset` 默认 0。每个队列项在入队时固定当前归类选择。游客界面隐藏归类操作。

文件选择、拖拽、粘贴由主题绑定；不能无差别拦截文本框粘贴。上传进度到达 100% 后仍可能处于服务端处理状态，成功以 `status: success` 为准。核心负责分片、并发、CSRF、上传密钥及权限。

首页与登录页共享宿主上传队列；进入后台会加载新文档，有未结束任务时提示离页。关闭、刷新或跨文档导航不保证上传恢复。

在 Vue 中，将 `subscribe()` 提供的快照保存到本地 ref，再由它驱动渲染。`ctx.t()`、`ctx.localized()` 和 `ctx.links.format()` 不会为主题自己的 Vue 实例建立响应式依赖；使用 computed 时，显式依赖快照中的 `locale` 或 `copy.format`。配置在一次挂载期间固定，草稿变化后重新加载预览。

## 配置与多语言文本

`configSchema` 生成后台配置表单，主题通过 `ctx.config` 读取保存值。省略 Schema 时配置为 `{}`。类型、组合约束和默认值规则见 [Schema 参考](./schema.md)，字段标签及控件见[包文案与表单提示](./package-localization.md)。主题不支持密钥和不可变字段，所有配置都可能公开给访客。

多语言内容字段使用 `x-localized`：

```json
{
  "type": "string",
  "x-localized": true,
  "minLength": 1,
  "default": { "en-US": "Welcome", "zh-CN": "欢迎" }
}
```

`default` 和保存值使用语言字典；字符串约束、`enum` 和 `const` 分别校验每种语言的文本。字典键只能是核心支持的语言标识。通过 `ctx.localized(ctx.config.heading)` 读取当前语言；缺失或为空时返回空字符串，不跨语言回退，也不应自行补回管理员已清空的内容。

### 草稿与完整校验

默认值仅初始化安装草稿和显式新增数组项；保存、读取、预览和应用不补值。主题字符串未声明 `maxLength` 时，上限为 10000 个 Unicode 字符。

| 操作 | 校验内容 |
| --- | --- |
| 保存草稿 | 类型、未知字段、`enum/const`、数值范围、字符串长度、模式与格式 |
| 预览或应用 | 上述规则，以及 `required`、组合和条件约束、数组长度与唯一性 |

预览和应用按全部 `supportedLocales` 校验，包括站点尚未启用的语言。每种语言生成自己的配置视图执行约束；条件不能跨语言比较，也不写回视图。必需多语言字段须覆盖全部支持语言。缺失翻译可先保存草稿，违反 `minLength: 1` 的空串仍不能保存。

`visibleWhen` 读取当前编辑语言的配置视图；隐藏不删除值，也不绕过校验。`password` 控件只是遮罩，不能保护主题配置中的凭据。URL 和 CSS 配置值由主题按用途处理。

## 多语言

清单必须声明非空的 `supportedLocales`，只能选择核心支持的语言；`defaultLocale` 必须属于该列表。主题名称和作者文案使用 `messages`，通过 `ctx.t(key, params)` 读取，支持 `{name}` 参数替换。字典完整性和回退规则见[包文案与表单提示](./package-localization.md#字典与回退)。

访客可用语言为站点启用语言与主题支持语言的交集。快照中的 `locales` 是语言标识列表，`languages` 提供名称与方向，`defaultLocale` 是站点默认语言。主题自行提供语言切换器；`setLocale()` 拒绝范围外语言，预览中切换不会持久化访客偏好。

上传和登录错误由宿主翻译。

## 相关说明

安装、草稿、应用及语言设置见[使用主题](../guide/themes.md)。

独立项目见[主题快速开始](./theme-tooling.md)，官方主题构建见[工具维护](./theme-tooling-maintenance.md#官方外部主题)。

恢复入口见[恢复默认页面](../guide/themes.md#恢复默认页面)，备份见[主题数据](../operations/data.md#主题数据)。

管理接口见 [HTTP API](../reference/http-api.md#主题管理)。
