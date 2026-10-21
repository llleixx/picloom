# 开发者指南

按开发目标选择入口。插件运行在 Bun 服务端，主题运行在浏览器，核心开发需要完整仓库。

| 目标 | 准备条件 | 从这里开始 |
| --- | --- | --- |
| 开发路径、存储或图片处理插件 | Bun、测试实例及 Owner 账号 | [插件快速开始](./plugin-tooling.md) |
| 自定义首页或登录页 | Bun、Vue / TypeScript 基础、测试实例 | [主题快速开始](./theme-tooling.md) |
| 修改 Picloom 本身 | Git、Bun、项目源码 | [本地开发](./contributing.md) → [架构导航](./architecture.md) |

插件和主题都以 ZIP 安装。请用独立测试实例验证上传、登录和外部服务操作。

实现配置时查阅 [Schema 参考](./schema.md)和[包文案与表单提示](./package-localization.md)。接口、示例和文档以当前代码为准。
