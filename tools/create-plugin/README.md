# @picloom/create-plugin

Create a standalone Picloom plugin project with Bun 1.4.3+. No main repository
checkout, Node.js or npm CLI is required.

**Not yet published.** After release:

```sh
bun create @picloom/plugin@0.1.0 ./my-plugin
```

The destination must not exist; its parent must exist. `--help` prints usage.
The tool copies a date path plugin template and prints next steps. It does not
install dependencies, start a service, or publish anything. Follow the generated
README to edit, build and install the plugin.

See [quick start](https://llleixx.github.io/picloom/development/plugin-tooling.html)
for the full workflow and local tarball usage before publication. Package
maintainers use [tool maintenance](https://github.com/llleixx/picloom/blob/main/docs/development/plugin-tooling-maintenance.md).

## 中文

使用 Bun 1.4.3+ 创建独立插件项目，无需主仓库、Node.js 或 npm CLI。
包尚未发布，上面的命令在发布后可用；当前本地压缩包用法见
[快速开始](https://llleixx.github.io/picloom/development/plugin-tooling.html#本地压缩包)。

目标目录必须不存在，父目录必须存在。工具只复制日期路径插件模板并提示下一步，
不安装依赖、不启动服务、不发布代码。生成后按项目内 README 修改、构建和安装插件。
