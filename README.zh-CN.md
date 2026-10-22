<p align="center">
  <img src="docs/public/picloom.svg" width="96" height="96" alt="Picloom">
</p>

# Picloom

自托管图床，支持多种存储后端和可配置的图片处理流程。

[English](README.md) · **简体中文**

[文档](https://llleixx.github.io/picloom/) · [快速开始](https://llleixx.github.io/picloom/guide/quick-start.html) · [MIT 许可证](LICENSE)

## 项目特点

- **多存储与多副本。** 接入本地目录、S3 兼容存储、WebDAV、OpenList 等，通过存储组选择主存储并保留冗余副本。
- **公开路径与存储路径分离。** 文件可以按分片目录存放，公开链接保持简短；多个副本共用一个公开路径。
- **三个阶段的处理流水线。** 保存前缩放、加水印，访问时生成不同尺寸，保存后执行审核或通知。处理步骤可以按需组合、复用。
- **原地导入已有图片。** 扫描本地、S3、OpenList 或 WebDAV 存储，无需重新上传。配合原域名和公开路径，可保留已有链接。
- **复用上传规则。** 上传配置组合存储、路径和处理规则，网页与 API 上传时选择即可；上传令牌可限定允许使用的配置。
- **网页管理。** 管理图片、副本与后台任务，支持分片上传和 SQLite 内置备份，也可通过路径、存储和处理插件扩展能力。

## 开始使用

按[Docker 快速开始](https://llleixx.github.io/picloom/guide/quick-start.html)部署并登录。首次启动会创建 `Default` 本地存储源、存储组和上传配置，可以直接上传图片。

- [常见场景](https://llleixx.github.io/picloom/guide/recipes.html)：配置多副本、缩略图、水印与审核。
- [图片管理](https://llleixx.github.io/picloom/guide/files.html)：替换图片并保留链接、导入已有图库。
- [备份与升级](https://llleixx.github.io/picloom/operations/data.html)：保存和恢复数据。
- [HTTP API](https://llleixx.github.io/picloom/reference/http-api.html)：接入上传工具。

内置本地、S3、WebDAV 存储及图片处理、水印、Telegram 通知。OpenList、NodeImage、Telegram 存储和腾讯云审核需[另行安装插件](https://llleixx.github.io/picloom/guide/plugins.html)；首页与登录页可[安装主题](https://llleixx.github.io/picloom/guide/themes.html)。

## 开发

使用 Bun、TypeScript 和 Vue，支持 SQLite 与 PostgreSQL。

- [本地开发](https://llleixx.github.io/picloom/development/contributing.html)：启动应用、修改核心代码。
- [插件开发](https://llleixx.github.io/picloom/development/plugin-tooling.html)与[主题开发](https://llleixx.github.io/picloom/development/theme-tooling.html)：创建独立扩展项目。
- [picloom-tooling](https://github.com/llleixx/picloom-tooling)：SDK、开发工具和脚手架。
- [picloom-extensions](https://github.com/llleixx/picloom-extensions)：可选官方插件与 Horizon 主题。

## 许可证

[MIT](LICENSE)
