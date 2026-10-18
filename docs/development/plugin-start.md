# 第一个插件

先从仓库中的路径插件示例开始。它没有外部依赖，容易验证打包、安装和配置流程。

## 构建示例

准备 Bun，以及用于打包的 `zip` 命令。在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run build:examples
```

产物位于 `outputs/examples/`，包含 `path.zip`、`storage.zip` 和 `processor.zip`。构建脚本会打包 SDK 引用，不需要在插件目录安装单独的 SDK 包。

## 安装与验证

1. 以 Owner 登录，打开插件页面。
2. 上传 `path.zip`，检查插件信息后确认信任并安装。
3. 新建上传配置，在路径插件中选择 Example date path，绑定已有存储组。
4. 上传图片，确认返回链接包含日期路径。

插件在服务主进程中以服务权限运行，不是沙箱。只安装可信代码。

## 包的结构

```text
plugin.json
index.js
```

ZIP 根目录需要包含清单，清单的 `entry` 指向包内 JavaScript 入口。入口默认导出插件定义；清单与导出定义的 ID、版本、类型和 API 版本应一致。

清单声明插件身份与入口：

<<< ../../examples/path/plugin.json

入口实现路径生成逻辑：

<<< ../../examples/path/index.ts

## 代码如何被调用

安装 ZIP 后，Picloom 读取清单并加载入口。创建上传配置时，宿主用保存的配置调用 `createInstance`；上传文件时，再调用该实例的 `generate`。

这个示例从 `uploadedAt` 取得 UTC 日期，从图片 MIME 类型取得扩展名，返回类似 `2026/10/18/<文件ID>.jpg` 的 `logicalKey`。它不负责连接存储，也不应自行添加上传配置的公开前缀。

可以将返回路径改为 `photos/${day}/${fileId}.${extension}`，体验一次修改：

1. 将清单和入口的版本都改为 `1.0.1`，保持 ID 一致。
2. 重新运行 `bun run build:examples`，安装生成的新包。
3. 编辑使用该插件的上传配置，预览并应用新版本。
4. 上传新图片，确认公开前缀之后出现 `photos/`；旧图片的路径保持不变。

只有返回 `logicalKey` 时，存储对象使用相同的相对键。需要不同存储命名时，可同时返回 `storageKey`。

发布自己的插件时更改 ID 和名称。已经安装的同 ID、同版本不能覆盖；修改代码后发布新版本，按实例逐项预览和应用升级。

继续阅读 [插件能力与返回协议](./plugin-api.md) 和 [错误、重试与取消](./plugin-errors.md)。
