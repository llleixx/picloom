---
layout: home
hero:
  name: Picloom
  text: 以插件编织你的自托管图床
  tagline: 自由组合存储、路径与图片处理插件，以主题定制主页与登录页面，让每一套上传配置契合你的使用方式。
  image:
    src: /picloom.svg
    alt: Picloom
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 理解 Picloom
      link: /guide/concepts
features:
  - title: 存储与分享
    details: 连接本地目录、S3 等存储，配置副本，统一管理公开链接。
    link: /guide/storage
    linkText: 配置存储
  - title: 图片处理
    details: 上传时缩放、加水印，访问时生成不同尺寸，保存后执行审核与通知。
    link: /guide/pipelines
    linkText: 配置流水线
  - title: 插件扩展
    details: 使用内置插件，或通过 TypeScript SDK 扩展路径、存储与处理能力。
    link: /development/plugin-tooling
    linkText: 开发插件
---

## 开始使用

Docker 部署后，默认配置即可上传图片并获取链接。需要不同的存储位置、路径或处理规则时，再创建上传配置。

## 文档入口

| 你想做什么 | 从这里开始 |
| --- | --- |
| 了解配置与使用流程 | [理解 Picloom](./guide/concepts.md) |
| 配置多副本、缩略图、水印或审核 | [常见场景](./guide/recipes.md) |
| 安装官方插件或替换首页主题 | [安装插件](./guide/plugins.md) · [使用主题](./guide/themes.md) |
| 部署服务、配置域名和备份 | [部署运维](./operations/deploy.md) |
| 编写自己的插件 | [插件开发](./development/plugin-tooling.md) |
| 修改 Picloom 核心代码 | [本地开发](./development/contributing.md) |
| 查阅设置或接入 API | [设置与环境变量](./reference/settings.md) · [HTTP API](./reference/http-api.md) |
