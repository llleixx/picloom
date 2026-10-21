# My Picloom plugin

A standalone plugin project using Bun 1.4.3+ and Picloom plugin API 1. Use a
separate Picloom 0.1.0 development test instance for installation and uploads.
Node.js and npm CLI are not required.

## Develop

```sh
bun install
bun run build
```

Commit the generated `bun.lock`. To check types without building, run
`bun run typecheck`. Both commands run TypeScript under Bun.

- `plugin.json`: plugin ID, version, kind and API version. Replace the
  generated `example.*` ID with your own stable ID before sharing.
- `src/index.ts`: localized display text (`defaultLocale` and `messages`), configuration and implementation. It reads identity fields from
  the manifest and initially generates UTC date paths. It omits `configSchema`
  because it has no custom configuration; the host accepts only `{}`.
- `package.json`: development dependencies and commands; its version is not the
  plugin version. The project is private to prevent accidental npm publication.
- `dist/<plugin-id>-<version>.zip`: build output, containing `plugin.json` and
  bundled `index.js` at the ZIP root. No system `zip` command is required.

Build loads your entry to check its identity, so keep module top-level code free
of external side effects. Sharp is a development dependency for SDK types;
use `services.images.sharp` at runtime. The template bundles JavaScript only;
extra assets and native modules require explicit packaging.

## Install and update

1. Sign in to the test instance as Owner and upload the ZIP in plugin management.
2. Review the identity, confirm trust, and check that the plugin loaded.
3. Select your path plugin in a test upload profile with an available storage group.
4. Upload a PNG and open its returned link. The starter path contains the UTC date
   and file ID, plus the profile's public prefix.
5. After code changes, increment `plugin.json`'s version, rebuild and install.
   In the profile choose the new version, preview and apply the upgrade.

Installation does not activate a plugin automatically. Same-version replacement
and source hot reload are not supported. See [packaging and upgrades](https://llleixx.github.io/picloom/development/plugin-release.html)
for configuration migrations and dependency restrictions.

For other plugin types and adapting the examples, follow
[quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html#使用教程示例).
See [host services](https://llleixx.github.io/picloom/development/plugin-config.html)
for configuration, secrets and state, and [errors and concurrency](https://llleixx.github.io/picloom/development/plugin-errors.html)
for retries, cancellation and instance lifecycle.

## 中文

本项目只需 Bun 1.4.3+。修改 `plugin.json` 的身份信息和 `src/index.ts` 的实现，
执行 `bun install`、`bun run build`，将生成的 `bun.lock` 提交到自己的插件仓库。
构建先检查类型，再输出 `dist/<插件ID>-<版本>.zip`，无需系统 `zip` 命令。

用 Owner 账号在独立测试实例中安装 ZIP，确认加载成功后，在上传配置中选择插件并
关联可用存储组。上传 PNG，确认日期路径和公开链接。改代码后增加清单版本，重新
构建安装，再选择新版本、预览并应用升级；安装新版不会自动切换已有配置。

模板没有自定义配置项，因此省略 `configSchema`，宿主只接受空配置 `{}`；添加配置项时再声明对象 Schema。

名称和简介通过 `nameKey/descriptionKey` 引用入口的 `messages` 字典，`defaultLocale` 指定内容默认语言。
入口从清单读取身份字段；`package.json` 的版本不是插件版本。构建会加载入口，
不要在模块顶层执行远端操作。Sharp 的开发依赖提供类型，运行时使用宿主实例。
其他类型和完整接口见上方文档链接。

## Before npm publication / npm 发布前

The SDK is not published yet. Before the first `bun install`, replace only its
existing development dependency value in `package.json` with the maintainer's tarball:

```json
{
  "@picloom/plugin-sdk": "file:/absolute/path/picloom-plugin-sdk-0.1.0.tgz"
}
```

Keep all other dependencies. SDK 尚未发布时，首次安装前只替换上述依赖值，保留其他
开发依赖。之后照常安装和构建；发布后可改回精确 registry 版本并更新锁文件。
