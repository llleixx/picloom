# 包文案与表单提示

插件和主题统一使用显式翻译键与 `messages` 字典。Schema 定义数据规则，字段内的 `x-ui` 引用语义键，不使用 Schema 路径作为翻译索引。宿主决定界面语言；包的 `defaultLocale` 仅用于作者文案回退，与站点默认语言独立。

```ts
nameKey: "package.name",
defaultLocale: "en-US",
messages: {
  "en-US": {
    "package.name": "Image size",
    "width.label": "Maximum width",
    "width.help": "Do not enlarge smaller images",
    "group.size": "Size",
  },
  "zh-CN": {
    "package.name": "图片尺寸",
    "width.label": "最大宽度",
    "width.help": "不放大小图",
    "group.size": "尺寸",
  },
},
configSchema: {
  type: "object",
  properties: {
    width: {
      type: "integer", minimum: 1,
      "x-ui": {
        labelKey: "width.label", descriptionKey: "width.help",
        groupKey: "group.size", order: 1, advanced: true,
      },
    },
  },
},
```

身份必填 `nameKey`，插件可另设 `descriptionKey`。整个插件在定义顶层声明唯一的 `defaultLocale/messages`，身份、各阶段配置和请求参数共享这一字典。阶段内不重复声明字典。

## 字典与回退

默认语言字典必须包含全部使用或翻译的键，值必须是非空白字符串；其他语言可以只翻译一部分。显示时逐键按「当前语言 → 基础语言（如 `zh`）→ 包默认语言」查找，仍找不到则显示键名。语言标识使用规范 BCP 47，插件字典不限于核心支持语言。声明未引用的键可以保留，用于复用文案。没有 `labelKey` 的字段显示字段名，没有 `enumKeys` 的枚举显示原值。

## 表单提示

| `x-ui` 字段 | 用途 |
| --- | --- |
| `labelKey`、`descriptionKey` | 标签和说明的翻译键 |
| `enumKeys` | 按枚举值顺序一一对应的翻译键 |
| `groupKey` | 分组名称的翻译键 |
| `order`、`advanced` | 排列顺序、是否为高级选项 |
| `widget` | `textarea` 多行输入或 `password` 遮罩输入 |
| `visibleWhen: { path, equals }` | 指定值满足条件时显示 |

可见性条件的 `path` 是配置值的 JSON Pointer；隐藏字段仍执行业务校验。`x-ui` 只影响显示，不改变数据默认值、约束或密钥行为。

主题多语言字段的声明与读取见[主题配置](./themes.md#配置与多语言文本)。

主题的字典语言必须属于 `supportedLocales`；插件字典没有此限制。`password` 只改变显示，密钥存储需要插件的 `x-sensitive`。主题配置可公开访问。

作者文案使用上述回退规则。管理员填写的多语言配置由 `ctx.localized()` 读取，缺失或为空时保持空字符串，不回退到其他语言。
