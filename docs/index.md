---
layout: home
hero:
  name: Picloom
  text: 自托管图片管理
  tagline: 将图片保存到本地或对象存储，按需添加水印、生成缩略图，通过链接分享。
  image:
    src: /picloom.svg
    alt: Picloom
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quick-start
    - theme: alt
      text: 使用指南
      link: /guide/concepts
features:
  - title: 多存储与副本
    details: 支持本地磁盘、S3 兼容存储等。可以指定主存储，也可以在其他存储源保留副本。
    link: /guide/storage
    linkText: 配置存储
  - title: 图片处理
    details: 上传时缩放或添加水印，访问时生成不同尺寸和格式的图片。审核、通知在保存后执行。
    link: /guide/pipelines
    linkText: 配置流水线
  - title: 插件扩展
    details: 路径生成、存储和处理均通过插件提供。使用 TypeScript SDK 编写插件，并在管理界面安装。
    link: /development/plugin-start
    linkText: 开发插件
---

## 开始使用

首次部署会自动创建本地存储源、存储组和上传配置，名称均为 `Default`。按 [快速开始](./guide/quick-start.md) 启动服务并登录，即可上传图片并获取链接。

上传配置决定图片存到哪里、使用什么路径，以及是否需要处理。不同用途可以使用不同的上传配置，例如给博客图片添加水印，给截图保留原始内容。配置关系见 [理解 Picloom](./guide/concepts.md)。

## 文档

| 内容 | 说明 |
| --- | --- |
| [使用指南](./guide/concepts.md) | 存储、上传配置、流水线与图片管理 |
| [常见场景](./guide/recipes.md) | 多副本、缩略图、水印与审核的配置示例 |
| [部署运维](./operations/deploy.md) | Docker 部署、域名、容量与备份 |
| [开发者指南](./development/plugin-start.md) | 插件 SDK、架构与本地开发 |
| [配置参考](./reference/settings.md) | 环境变量、HTTP API 与图片参数 |
