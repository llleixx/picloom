<p align="center">
  <img src="docs/public/picloom.svg" width="96" height="96" alt="Picloom">
</p>

# Picloom

自托管图床，支持多种存储后端和可配置的图片处理流程。

[English](README.md) · **简体中文**

[文档](https://llleixx.github.io/picloom/) · [快速开始](https://llleixx.github.io/picloom/guide/quick-start.html) · [MIT 许可证](LICENSE)

## 项目特点

- **自托管部署。** 支持 Docker 部署，数据库可选 SQLite 或 PostgreSQL。
- **个性化主题。** 自定义主页与登录页面，打造自己的图床界面。
- **插件扩展。** 按需扩展存储、图片处理和路径规则：
  - 接入多种存储后端，或导入支持的存储源，接管已有图库。
  - 上传时压缩、缩放、转换格式、添加水印，自动打标签和归入集合。
  - 上传后审核图片内容，并按处理结果发送通知。
  - 通过 URL 参数按需生成图片变体，保留原图。
  - 自定义公开链接与存储路径，支持日期、随机字符串等命名规则，也可通过插件实现自定义路径逻辑。
- **多套上传配置。** 自由组合存储、路径与处理插件，为不同用途配置独立的上传规则。
- **上传参数自定义。** 在同一套上传配置下，通过上传时传入的参数灵活调整处理行为，满足不同图片的个性化需求。
- **多副本存储。** 同时向多个存储源写入图片，多个副本共用一个公开链接，提高图片可用性。
- **标签与集合。** 灵活归类图片，支持筛选查找与批量管理。
- **保留链接替换图片。** 更新图片内容，无需修改已发布的引用链接。
- **多用户与游客上传。** 支持多用户管理、上传权限控制与游客上传限流。
- **上传工具与 API 集成。** 支持 PicGo、ShareX，通过 HTTP API 接入自己的应用或工作流。
- **分片上传。** 支持将文件拆分上传，满足大文件上传需求。
- **多语言支持。** 提供中英文界面，支持扩展更多语言，面向不同语言的用户。

## 开始使用

按[Docker 快速开始](https://llleixx.github.io/picloom/guide/quick-start.html)部署并登录。首次启动会创建 `Default` 本地存储源、存储组和上传配置，可以直接上传图片。

- [常见场景](https://llleixx.github.io/picloom/guide/recipes.html)：配置多副本、缩略图、水印与审核。
- [图片管理](https://llleixx.github.io/picloom/guide/files.html)：替换图片并保留链接、导入已有图库。
- [备份与升级](https://llleixx.github.io/picloom/operations/data.html)：保存和恢复数据。
- [外部集成](https://llleixx.github.io/picloom/guide/integrations.html)：通过 ShareX 或 PicGo 上传图片。
- [HTTP API](https://llleixx.github.io/picloom/reference/http-api.html)：接入上传工具。

通过插件扩展存储与图片处理能力，通过主题自定义网站界面。查看[插件列表](https://llleixx.github.io/picloom/reference/plugins.html)、[插件安装说明](https://llleixx.github.io/picloom/guide/plugins.html)和[主题安装说明](https://llleixx.github.io/picloom/guide/themes.html)。

## 开发

使用 Bun、TypeScript 和 Vue，支持 SQLite 与 PostgreSQL。

- [本地开发](https://llleixx.github.io/picloom/development/contributing.html)：启动应用、修改核心代码。
- [插件开发](https://llleixx.github.io/picloom/development/plugin-tooling.html)与[主题开发](https://llleixx.github.io/picloom/development/theme-tooling.html)：创建独立扩展项目。
- [picloom-tooling](https://github.com/llleixx/picloom-tooling)：SDK、开发工具和脚手架。
- [picloom-extensions](https://github.com/llleixx/picloom-extensions)：可选官方插件与主题。

## 许可证

[MIT](LICENSE)
