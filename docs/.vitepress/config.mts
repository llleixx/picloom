import { defineConfig } from "vitepress";
import { zh } from "./zh";

// Add a locale (e.g. en: { lang: 'en-US', link: '/en/', ... }) only when translated pages exist.
export default defineConfig({
  title: "Picloom",
  description: "自托管图片管理服务，支持多存储、水印、图片处理和插件扩展。",
  base: process.env.DOCS_BASE || "/",
  lastUpdated: true,
  // Local development notes are not public documentation.
  srcExclude: ["dev/**"],
  locales: { root: { label: "简体中文", lang: "zh-CN", ...zh } },
  themeConfig: {
    logo: "/picloom.svg",
    socialLinks: [
      { icon: "github", link: "https://github.com/llleixx/picloom" },
    ],
    search: {
      provider: "local",
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
              modal: {
                displayDetails: "显示详情",
                resetButtonTitle: "清除搜索",
                backButtonTitle: "返回",
                noResultsText: "未找到相关内容",
                footer: {
                  selectText: "选择",
                  navigateText: "切换",
                  closeText: "关闭",
                },
              },
            },
          },
        },
      },
    },
  },
});
