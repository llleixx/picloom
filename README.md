<p align="center">
  <img src="docs/public/picloom.svg" width="96" height="96" alt="Picloom">
</p>

# Picloom

A self-hosted image hosting service with multiple storage backends and configurable image processing.

**English** · [简体中文](README.zh-CN.md)

[Documentation (中文)](https://llleixx.github.io/picloom/) · [Quick start (中文)](https://llleixx.github.io/picloom/guide/quick-start.html) · [MIT License](LICENSE)

## Features

- **Self-hosted deployment.** Deploy with Docker and choose SQLite or PostgreSQL as your database.
- **Customizable themes.** Customize your homepage and login page to give your image hosting site its own look.
- **Plugin extensions.** Extend storage, image processing and path rules as needed:
  - Connect multiple storage backends, or import images from supported storage sources to take over an existing library.
  - Compress, resize, convert formats and add watermarks during upload, with automatic tagging and collection assignment.
  - Moderate images after upload and send notifications based on processing results.
  - Generate image variants through URL parameters while preserving the original.
  - Customize public URLs and storage paths with dates, random strings or your own plugin-defined rules.
- **Multiple upload profiles.** Combine storage, path and processing plugins into distinct upload rules for different uses.
- **Custom upload parameters.** Adjust processing behavior with parameters supplied at upload time, tailoring individual uploads while reusing the same upload profile.
- **Replicated storage.** Write images to multiple storage sources concurrently. Replicas share one public URL and improve image availability.
- **Tags and collections.** Organize images with flexible categorization, filtering and batch management.
- **Replace images without changing links.** Update image content without editing published references.
- **Multi-user and guest uploads.** Manage multiple users, control upload permissions and apply rate limits to guest uploads.
- **Upload tools and API integration.** Upload with PicGo or ShareX, or use the HTTP API to integrate your own applications and workflows.
- **Chunked uploads.** Split files into chunks to support large file uploads.
- **Multilingual support.** Chinese and English interfaces, with support for adding more languages to serve users worldwide.

## Getting started

Follow the [Docker quick start (中文)](https://llleixx.github.io/picloom/guide/quick-start.html) to deploy and sign in. A fresh installation creates a local storage source, storage group and upload profile named `Default`, ready for uploads.

- [Common recipes (中文)](https://llleixx.github.io/picloom/guide/recipes.html): replicas, thumbnails, watermarks and moderation.
- [Image management (中文)](https://llleixx.github.io/picloom/guide/files.html): replace images while keeping links, or import an existing library.
- [Backups and upgrades (中文)](https://llleixx.github.io/picloom/operations/data.html): save and restore data.
- [External integrations (中文)](https://llleixx.github.io/picloom/guide/integrations.html): upload images with ShareX or PicGo.
- [HTTP API (中文)](https://llleixx.github.io/picloom/reference/http-api.html): integrate upload tools.

Extend storage and image processing with plugins, and customize the website with themes. See the [plugin list (中文)](https://llleixx.github.io/picloom/reference/plugins.html), [plugin installation (中文)](https://llleixx.github.io/picloom/guide/plugins.html) and [theme installation (中文)](https://llleixx.github.io/picloom/guide/themes.html).

## Development

Built with Bun, TypeScript and Vue; supports SQLite and PostgreSQL.

- [Local development (中文)](https://llleixx.github.io/picloom/development/contributing.html): run the application and change core code.
- [Plugin development (中文)](https://llleixx.github.io/picloom/development/plugin-tooling.html) and [theme development (中文)](https://llleixx.github.io/picloom/development/theme-tooling.html): create standalone extensions.
- [picloom-tooling](https://github.com/llleixx/picloom-tooling): SDKs, development tools and project generators.
- [picloom-extensions](https://github.com/llleixx/picloom-extensions): optional official plugins and themes.

## License

[MIT](LICENSE)
