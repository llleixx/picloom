import type { LocaleSpecificConfig, DefaultTheme } from "vitepress";
const guide = [
  {
    text: "开始使用",
    items: [
      { text: "快速开始", link: "/guide/quick-start" },
      { text: "理解 Picloom", link: "/guide/concepts" },
    ],
  },
  {
    text: "配置与使用",
    items: [
      { text: "存储源与存储组", link: "/guide/storage" },
      { text: "上传配置与公开路径", link: "/guide/profiles" },
      { text: "流水线", link: "/guide/pipelines" },
      { text: "图片管理", link: "/guide/files" },
      { text: "用户、游客与令牌", link: "/guide/access" },
      { text: "安装与使用插件", link: "/guide/plugins" },
      { text: "安装与使用主题", link: "/guide/themes" },
      { text: "常见场景", link: "/guide/recipes" },
    ],
  },
];
const operations = [
  {
    text: "部署运维",
    items: [
      { text: "Docker 部署", link: "/operations/deploy" },
      { text: "域名与反向代理", link: "/operations/proxy" },
      { text: "数据、备份与升级", link: "/operations/data" },
      { text: "容量与并发", link: "/operations/resources" },
      { text: "故障排查", link: "/operations/troubleshooting" },
    ],
  },
];
const development = [
  { text: "开发者指南", link: "/development/" },
  {
    text: "插件开发",
    items: [
      { text: "快速开始", link: "/development/plugin-tooling" },
      { text: "插件基础", link: "/development/plugin-start" },
      { text: "路径插件", link: "/development/plugin-path" },
      { text: "存储插件", link: "/development/plugin-storage" },
      {
        text: "处理插件",
        link: "/development/plugin-api",
        collapsed: false,
        items: [
          { text: "上传处理", link: "/development/processors/upload" },
          { text: "访问处理", link: "/development/processors/access" },
          { text: "保存后处理", link: "/development/processors/post-save" },
        ],
      },
      { text: "配置与请求参数", link: "/development/plugin-config" },
      { text: "宿主服务与运行上下文", link: "/development/plugin-services" },
      { text: "错误、取消与并发", link: "/development/plugin-errors" },
      { text: "打包与升级", link: "/development/plugin-release" },
    ],
  },
  {
    text: "主题开发",
    items: [
      { text: "快速开始", link: "/development/theme-tooling" },
      { text: "主题协议", link: "/development/themes" },
    ],
  },
  {
    text: "参考",
    items: [
      { text: "Schema 参考", link: "/development/schema" },
      { text: "包文案与表单提示", link: "/development/package-localization" },
    ],
  },
  {
    text: "核心开发",
    items: [
      { text: "本地开发", link: "/development/contributing" },
      { text: "插件工具维护", link: "/development/plugin-tooling-maintenance" },
      { text: "主题工具维护", link: "/development/theme-tooling-maintenance" },
      { text: "架构与代码导航", link: "/development/architecture" },
      { text: "数据访问与初始化", link: "/development/persistence" },
      { text: "状态、任务与资源生命周期", link: "/development/states" },
      { text: "文档站维护", link: "/development/docs" },
    ],
  },
];
const reference = [
  {
    text: "查阅",
    items: [
      { text: "设置与环境变量", link: "/reference/settings" },
      { text: "HTTP API", link: "/reference/http-api" },
      {
        text: "官方插件",
        link: "/reference/plugins",
        collapsed: true,
        items: [
          { text: "日期路径", link: "/reference/plugins/date-path" },
          { text: "随机路径", link: "/reference/plugins/random-path" },
          { text: "本地存储", link: "/reference/plugins/local" },
          { text: "S3 兼容存储", link: "/reference/plugins/s3" },
          { text: "WebDAV 存储", link: "/reference/plugins/webdav" },
          { text: "OpenList 存储", link: "/reference/plugins/openlist" },
          { text: "NodeImage 存储", link: "/reference/plugins/nodeimage" },
          { text: "Telegram 存储", link: "/reference/plugins/telegram" },
          { text: "图片处理", link: "/reference/plugins/sharp" },
          { text: "水印", link: "/reference/plugins/watermark" },
          {
            text: "腾讯云图片审核",
            link: "/reference/plugins/tencent-moderation",
          },
          {
            text: "Telegram 通知",
            link: "/reference/plugins/telegram-notification",
          },
        ],
      },
      { text: "术语", link: "/reference/glossary" },
    ],
  },
];
export const zh: LocaleSpecificConfig<DefaultTheme.Config> = {
  themeConfig: {
    nav: [
      { text: "使用指南", link: "/guide/quick-start", activeMatch: "/guide/" },
      {
        text: "部署运维",
        link: "/operations/deploy",
        activeMatch: "/operations/",
      },
      {
        text: "开发者",
        link: "/development/",
        activeMatch: "/development/",
      },
      { text: "参考", link: "/reference/settings", activeMatch: "/reference/" },
    ],
    sidebar: {
      "/guide/": guide,
      "/operations/": operations,
      "/development/": development,
      "/reference/": reference,
    },
    outline: { label: "本页目录", level: [2, 3] },
    docFooter: { prev: "上一篇", next: "下一篇" },
    editLink: {
      pattern: "https://github.com/llleixx/picloom/edit/main/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
    lastUpdated: { text: "最后更新" },
    sidebarMenuLabel: "目录",
    returnToTopLabel: "返回顶部",
    darkModeSwitchLabel: "切换主题",
    langMenuLabel: "语言",
    skipToContentLabel: "跳至正文",
    footer: {
      message:
        "文档随 main 分支维护；部署与升级请核对产物版本及兼容说明。",
    },
  },
};
