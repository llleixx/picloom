# 首页与登录页主题

主题是运行在浏览器内的可信前端扩展，可完整替换首页和登录页。管理后台不加载主题代码。只允许站点所有者安装；登录页主题可以读取用户输入的账号密码，请审查来源后安装。

## 安装与配置

在 **管理后台 → 主题** 上传 ZIP，检查名称与版本，确认信任后安装。安装不会自动启用。

选择“配置”，编辑后保存草稿；“预览首页／登录页”使用已保存草稿并在新窗口打开。“应用到网站”保存当前编辑内容并将版本与配置一起发布。保存草稿本身不改变线上内容。预览中的上传、登录是真实操作，不要把预览当作测试数据隔离区。

一个主题版本作用于整站；缺少首页或登录页时，该页使用默认页面。每个版本独立安装和配置，新版本从自己的 Schema 默认配置开始，不提供跨版本配置复制或迁移。启用版本不能卸载；恢复默认后可以卸载，卸载也会删除该版本草稿。

网站名称、简介、Logo、favicon 和站点语言仍在站点设置里，主题通过 SDK 读取。主题的宣传文案不会修改网站名称或浏览器标题。图片只需普通 URL 配置，不提供专用上传流程。

## 构建示例

在仓库根目录运行：

```sh
bun run build:themes
```

需要 Linux `zip` 命令。生成 `outputs/themes/split.zip` 和 `outputs/themes/horizon.zip`，在隔离的开发站点安装并预览即可。也可使用 `bun run build:themes horizon` 单独构建远空主题。`examples/themes/split` 同时是 Vue 3 开发模板，包含左右分栏布局、上传、登录、明暗模式、中英文和多语言配置。

`examples/themes/horizon` 是「Horizon · 远空」完整主题：内置四张二次元风景插画、全屏淡入淡出轮换、半透明上传与登录面板、移动布局和双语文案。后台可配置标题、说明、轮换间隔、遮罩与替代图片 URL，详见该目录的 README。

修改示例后重新构建，使用新的 `version` 安装；同 ID、同版本不能覆盖，避免不可变资源缓存返回旧文件。开发时也可卸载未启用的测试版本后重新安装，但不要以相同版本替换已对外分发的不同内容。

示例入口自行打包 Vue；不要引用 `web/src`、宿主组件或共享 Vue 实例。类型从 `theme-sdk/index.ts` 导入，独立项目可安装本地 `theme-sdk` 包并从 `@picloom/theme-sdk` 导入类型。包只提供类型，运行时能力由宿主注入。

## 主题包

ZIP 根目录必须直接包含 `theme.json`，不要多包一层目录：

```json
{
  "id": "example.split",
  "defaultLocale": "en-US",
  "content": { "zh-CN": { "name": "分栏" }, "en-US": { "name": "Split" } },
  "version": "1.0.0",
  "apiVersion": 1,
  "supportedLocales": ["zh-CN", "en-US"],
  "messages": { "zh-CN": {}, "en-US": {} },
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
        "title": "Accent color",
        "content": { "zh-CN": { "title": "主色" } }
      }
    }
  }
}
```

至少提供一个页面。页面也可声明自己的 `styles`；`preview` 可指向包内 PNG、JPEG 或 WebP 预览图。JavaScript 必须是浏览器 ESM，依赖随包构建，不执行服务器安装脚本。上限为 ZIP 20 MB、解压后 50 MB、512 项；入口、样式和预览图必须存在，文件路径不能越界。

配置支持 `object`、`string`、`number`、`integer`、`boolean`，以及 `properties`、`required`、`enum`、`default`、`minimum`、`maximum`、`minLength`、`maxLength`。对象不接受未声明字段。必填字段可以不提供默认值。安装时保存已声明的默认配置；安装和保存草稿允许缺少必填项，但已提供值仍须符合类型、长度等约束。预览和应用时执行完整校验，缺失必填项会阻止操作。`required` 表示字段必须存在，文本不能为空需另设 `minLength: 1`。多语言必填字段在完整校验时须包含每种主题支持语言的值。数值、布尔等运行必需字段应声明为 `required`，缺失时由校验报错，不在主题页面中另设默认值。

- `x-multiline: true`：多行文本。
- `x-localized: true`：多语言文本，值为 `{ "zh-CN": "…", "en-US": "…" }`。
- `content`：字段的本地化 `title`、`description`、`enumLabels`。
- 不支持任意 JSON Schema 扩展、远程引用、秘密字段或配置界面脚本。

所有主题配置都可能公开给访客，不保存凭据。URL、CSS 值等最终由可信主题按用途处理。

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

## 多语言

核心的统一语言清单定义支持的语言、名称和方向。主题必须声明非空的 `supportedLocales`，只能使用核心支持的语言，必须声明属于支持语言的 `defaultLocale`，用于包内文案回退。`messages` 的默认语言字典必须包含全部翻译键；其他支持语言可省略字典或部分键，已提供的值不能空白。主题不使用任何翻译键时可提供空的默认语言字典。`ctx.t` 按当前语言、主题默认语言查找，仍缺失时显示键名，支持 `{name}` 参数替换。

站点默认语言只有一份，主题配置面板和站点设置提供两个入口。主题面板保存的语言选择仅供草稿预览；应用时与主题快照原子发布。默认语言必须是站点已启用且主题支持的语言。站点语言设置发生并发修改时，应用返回冲突，需要刷新确认。

第三方主题页面的语言范围为站点启用语言与主题支持语言的交集。SDK 的 `locales` 保留语言标识列表，`languages` 提供名称及方向，`defaultLocale` 提供站点默认语言。主题自行决定是否提供切换器；官方示例在可选语言多于一种时显示。`setLocale` 拒绝范围外的语言；预览内切换不会持久化访客偏好。缺失页面或加载失败时，内置页面恢复核心语言规则。

多语言配置面板一次编辑一种语言，未启用的主题语言也可以提前填写。`ctx.localized` 仅返回当前语言实际值，缺失或为空返回空字符串，不跨语言回退。安装主题版本时，`default` 经校验后实际保存为初始草稿；读取、重启和应用不再填充默认值，清空后不会自动恢复。网站名称、简介也遵循实际值规则。不要在官方主题中用站点信息或内置文案替代空配置。字段标签按后台语言、主题默认语言读取，仍缺失时使用基础标签或字段名，与配置值分开处理。

上传、登录错误由核心翻译。新增语言需要注册核心语言并补充核心字典，主题再按需增加字典及支持声明；无需改动配置面板或语言选择器。

## 恢复与备份

- `/?theme=default`、`/login?theme=default` 在导入主题前强制使用默认页面，不依赖主题配置接口成功。
- 后台未登录时会跳转默认登录页；默认模式在登录失败后保留。
- 加载失败或挂载异常自动回退，仅影响当前页面，不修改全站启用配置。任意 JavaScript 无限循环不保证自动恢复，应重新访问默认入口。
- 包在数据目录 `themes/`，草稿及启用快照在 `site-settings.json`。应用升级不会覆盖。
- SQLite 应用备份包含两者；仅恢复包含当前格式配置快照的备份。PostgreSQL 不提供应用内备份恢复，请随部署备份上述文件与数据库。

## HTTP 接口

`GET /api/theme` 返回启用主题描述或 `null`，匿名可读。其余主题管理接口限所有者，写请求使用会话 CSRF：

| 方法与路径                             | 内容                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/themes`                      | 已安装主题、兼容状态和候选配置                                            |
| `POST /api/themes/inspect`             | 请求体为原始 ZIP 字节，返回 `ticket` 和 `manifest`，凭据有效期 15 分钟    |
| `POST /api/themes/install`             | `{ "ticket": "…", "confirmed": true }`                                    |
| `PUT /api/themes/:id/:version/config`  | `{ config, language: { defaultLocale, languageRevision } }`                                                  |
| `GET /api/themes/:id/:version/preview` | 读取该版本候选配置及资源入口                                              |
| `PUT /api/theme`                       | `{ id, version, defaultLocale, languageRevision }` 启用已保存草稿；`{ "id": null }` 恢复默认 |
| `DELETE /api/themes/:id/:version`      | 卸载非启用版本                                                            |

资源位于 `/assets/themes/:id/:version/...`，可公开获取并长期缓存。不要将未发布的敏感文件放入主题包。后台使用的配置、预览权限不等于包内资源访问隔离。

站点与主题状态集中保存在版本化的 `site-settings.json`，不读取或迁移旧格式配置文件。主题清单校验失败时保留包与草稿并标记为不兼容，运行时使用默认页面。

主题名称只在清单的 `content[语言].name` 声明，不提供外层 `name`。主题 `defaultLocale` 对应的名称必填。后台只显示当前界面语言对应的一份名称，缺少时使用主题默认语言名称。配置项标签、说明、枚举标签和功能字典也按当前语言、主题默认语言读取。名称翻译可使用核心支持的任意语言，不受前台支持范围限制。主题默认语言属于包元信息，不改变站点默认语言、访客语言选择或前台可用语言范围。管理员配置值继续保持空值，不跨语言回退。
