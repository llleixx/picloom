# Picloom

自托管图片管理服务。将图片保存到本地或对象存储，按需添加水印、生成缩略图，通过链接分享。

- 多存储源、主副本与冗余副本。
- 上传与分片上传，图片管理、用户和上传令牌。
- 图片变换、水印、保存后审核与通知。
- 内置和外部插件共用 SDK。

## 开始使用

从 [快速开始](docs/guide/quick-start.md) 完成 Docker 部署、存储配置和第一张图片上传。

- [理解配置关系](docs/guide/concepts.md)
- [Docker 部署](docs/operations/deploy.md) · [备份与升级](docs/operations/data.md)
- [插件开发](docs/development/plugin-start.md) · [核心开发](docs/development/contributing.md)

当前版本为 `0.1.0` 开发版本。升级前核对数据兼容性并保留备份。

## 本地运行

```sh
bun install --frozen-lockfile
cp .env.example .env
```

设置 `.env` 中的 `ENCRYPTION_KEY`（32 字节随机密钥的 64 位十六进制表示）及初始 Owner 密码，然后执行：

```sh
bun run init-dev
bun run build:web
bun run dev
```

完整说明见 [本地开发](docs/development/contributing.md)。

## 文档站

```sh
bun install --cwd docs --frozen-lockfile
bun run docs:dev
```

使用 VitePress 构建，中文优先，预留多语言入口。GitHub Actions 发布到 GitHub Pages，首次启用方法见 [文档站维护](docs/development/docs.md)。
