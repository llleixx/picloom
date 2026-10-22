<p align="center">
  <img src="docs/public/picloom.svg" width="96" height="96" alt="Picloom">
</p>

# Picloom

A self-hosted image hosting service with multiple storage backends and configurable image processing.

**English** · [简体中文](README.zh-CN.md)

[Documentation (中文)](https://llleixx.github.io/picloom/) · [Quick start (中文)](https://llleixx.github.io/picloom/guide/quick-start.html) · [MIT License](LICENSE)

## Features

- **Multiple storage backends and replicas.** Connect local directories, S3-compatible storage, WebDAV, OpenList and more. Use storage groups to select primary storage and keep redundant copies.
- **Separate public and storage paths.** Organize files in sharded directories while keeping public URLs flat. Replicas share one public path.
- **Processing at three stages.** Resize or watermark images before saving, generate variants on access, and run moderation or notifications after saving. Combine steps into reusable pipelines.
- **Import existing images in place.** Scan local, S3, OpenList or WebDAV storage without uploading again. Preserve existing links by matching the domain and public paths.
- **Reusable upload profiles.** Choose storage, path rules and processing once, then select a profile when uploading through the web interface or API. Upload tokens can be restricted to specific profiles.
- **Web management.** Manage images, replicas and background tasks; use chunked uploads and built-in SQLite backups. Add capabilities with path, storage and processing plugins.

## Getting started

Follow the [Docker quick start (中文)](https://llleixx.github.io/picloom/guide/quick-start.html) to deploy and sign in. A fresh installation creates a local storage source, storage group and upload profile named `Default`, ready for uploads.

- [Common recipes (中文)](https://llleixx.github.io/picloom/guide/recipes.html): replicas, thumbnails, watermarks and moderation.
- [Image management (中文)](https://llleixx.github.io/picloom/guide/files.html): replace images while keeping links, or import an existing library.
- [Backups and upgrades (中文)](https://llleixx.github.io/picloom/operations/data.html): save and restore data.
- [HTTP API (中文)](https://llleixx.github.io/picloom/reference/http-api.html): integrate upload tools.

Local, S3 and WebDAV storage, image processing, watermarks and Telegram notifications are built in. OpenList, NodeImage, Telegram storage and Tencent moderation require [plugin installation (中文)](https://llleixx.github.io/picloom/guide/plugins.html). You can also [install a theme (中文)](https://llleixx.github.io/picloom/guide/themes.html) for the home and login pages.

## Development

Built with Bun, TypeScript and Vue; supports SQLite and PostgreSQL.

- [Local development (中文)](https://llleixx.github.io/picloom/development/contributing.html): run the application and change core code.
- [Plugin development (中文)](https://llleixx.github.io/picloom/development/plugin-tooling.html) and [theme development (中文)](https://llleixx.github.io/picloom/development/theme-tooling.html): create standalone extensions.
- [picloom-tooling](https://github.com/llleixx/picloom-tooling): SDKs, development tools and project generators.
- [picloom-extensions](https://github.com/llleixx/picloom-extensions): optional official plugins and the Horizon theme.

## License

[MIT](LICENSE)
