import type { LocaleSpecificConfig, DefaultTheme } from "vitepress";
const guide = [
  {
    text: "开始使用",
    items: [
      { text: "快速开始", link: "/guide/quick-start" },
      { text: "理解 Picloom", link: "/guide/concepts" },
      { text: "上传与分享", link: "/guide/upload" },
    ],
  },
  {
    text: "配置与使用",
    items: [
      { text: "存储源与存储组", link: "/guide/storage" },
      { text: "上传配置与公开路径", link: "/guide/profiles" },
      { text: "三阶段流水线", link: "/guide/pipelines" },
      { text: "文件、副本与导入", link: "/guide/files" },
      { text: "用户、游客与令牌", link: "/guide/access" },
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
      { text: "数据、升级与备份", link: "/operations/data" },
      { text: "容量与并发", link: "/operations/resources" },
      { text: "故障排查", link: "/operations/troubleshooting" },
    ],
  },
];
const development = [
  {
    text: "插件开发",
    items: [
      { text: "第一个插件", link: "/development/plugin-start" },
      { text: "插件能力与返回协议", link: "/development/plugin-api" },
      { text: "配置、密钥与版本", link: "/development/plugin-config" },
      { text: "错误、重试与取消", link: "/development/plugin-errors" },
    ],
  },
  {
    text: "核心开发",
    items: [
      { text: "本地开发与贡献", link: "/development/contributing" },
      { text: "架构与数据流", link: "/development/architecture" },
      { text: "状态与后台任务", link: "/development/states" },
      { text: "维护文档站", link: "/development/docs" },
    ],
  },
];
const reference = [
  {
    text: "查阅",
    items: [
      { text: "设置与环境变量", link: "/reference/settings" },
      { text: "HTTP API", link: "/reference/http-api" },
      { text: "图片参数", link: "/reference/image-params" },
      { text: "内置插件", link: "/reference/plugins" },
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
        link: "/development/plugin-start",
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
        "文档对应 main 分支的 0.1.0 开发版本；部署其他版本前请核对差异。",
    },
  },
};
