# @picloom/plugin-sdk

Public TypeScript interfaces and runtime helpers for Picloom plugins. Maintained
in the Picloom repository; plugin authors do not need to clone that repository.

**Publication status: prepared locally; not yet published to npm.** The registry
commands below apply after release. For unpublished local tarballs, see
[quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html#本地压缩包).

```sh
bun add --dev @picloom/plugin-sdk@0.1.0 sharp@0.34.5
```

```ts
import { PluginError, type Definition } from "@picloom/plugin-sdk";
```

Use ESM with TypeScript `moduleResolution: "Bundler"` and Bun types. The SDK
contains types for `path`, `storage`, and `processor` plugins, configuration,
host services, errors, and file/stream helpers. It does not start Picloom.

`sharp` is an optional peer because the public `services.images.sharp` type
references its declarations. Install it as a development dependency for complete
type checking, even for the initial path template. At runtime use
`services.images.sharp`; do not import or bundle your own Sharp runtime.

Bundle the SDK's runtime helpers with your plugin. Node/Bun builtins remain host
dependencies. Picloom does not install npm dependencies from plugin ZIPs.

| SDK | Plugin API | Host |
| --- | --- | --- |
| 0.1.0 (unpublished) | 1 | Current Picloom 0.1.0 development source |

Plugin development uses Bun 1.4.3+; Node.js and npm CLI are not required.
SDK versions and plugin code versions are independent; `apiVersion` is the host protocol, not the SDK version.
Interfaces may change before 1.0; pin the SDK version and review release notes.

## 中文

本包独立提供插件类型与辅助函数，不包含 Picloom 服务。当前仅准备本地发布产物，
尚未发布 npm。宿主兼容范围见上表，不保证任意旧版开发构建均兼容。

Sharp 为可选 peer dependency，但完整类型检查仍需安装它的声明，因此模板将
Sharp 放在开发依赖中。运行时使用宿主的 `services.images.sharp`，不打包另一套原生库。

插件开发使用 Bun；请将首次安装生成的 `bun.lock` 提交到自己的插件仓库。
普通插件以 ZIP 安装到 Picloom，无需将插件自身发布到 npm。

See [quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html)
and [host services](https://llleixx.github.io/picloom/development/plugin-config.html).
