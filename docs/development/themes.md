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

至少提供一个页面。页面也可声明自己的 `styles`；`preview` 可指向包内 PNG、JPEG 或 WebP 预览图。JavaScript 必须是浏览器 ESM，依赖随包构建，不执行服务器安装脚本。上限为 ZIP 20 MiB、解压后 50 MiB、512 项；入口、样式和预览图必须存在，文件路径不能越界。

同 ID、同版本不能覆盖安装。分发内容变化时增加 `version`。框架和依赖随主题打包，不引用宿主组件或共享 Vue 实例。包内资源可公开访问，不包含凭据。

## 生命周期与能力

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

完整类型以 SDK 为准。`subscribe` 立即提供一次状态，随后响应变化；返回快照不用于修改核心状态。主题通过操作函数提交行为：

- `selectProfile`、`uploads.add/addUrls/cancel/resume/dismiss`：上传方案和队列。
- `links`：链接格式及复制偏好。
- `login`：认证、会话刷新与安全返回，主题展示 `snapshot.login`。
- `navigate`：首页、登录页和后台跳转。
- `setLocale`、`setMode`：共享语言及显示偏好。
- `asset`：解析包内资源；`config`：配置；`t`：主题字典；`localized`：解析多语言配置。

文件选择、拖拽、粘贴由主题绑定；不能无差别拦截文本框粘贴。上传进度到达 100% 后仍可能处于服务端处理状态，成功以 `status: success` 为准。核心负责分片、并发、CSRF、上传密钥及权限。

离开页面必须清理主题自行创建的定时器、DOM 监听器和框架实例。首页与登录页共享宿主上传队列；进入后台会加载新文档，有未结束任务时提示离页。关闭、刷新或跨文档导航不保证上传恢复。

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

上传、登录错误由核心翻译，语言切换不重启通知关闭计时器。新增核心语言时先注册语言并补充核心字典，再由主题增加支持声明和文案。

## 相关说明

<span id="安装与配置"></span>
安装、草稿、应用及语言设置见[使用主题](../guide/themes.md)。

<span id="构建示例"></span>
独立项目见[主题快速开始](./theme-tooling.md)，仓库示例构建见[工具维护](./theme-tooling-maintenance.md#仓库示例)。

<span id="恢复与备份"></span>
恢复入口见[恢复默认页面](../guide/themes.md#恢复默认页面)，备份见[主题数据](../operations/data.md#主题数据)。

<span id="http-接口"></span>
管理接口见 [HTTP API](../reference/http-api.md#主题管理)。
