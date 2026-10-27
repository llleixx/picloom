# 本地开发

本地开发直接运行 Bun 后端和 Vue 前端。默认使用 SQLite，无需启动数据库容器；数据保存在仓库的 `data/` 中。不要与正在运行的部署共用数据目录。

## 准备环境

需要 Git、Bun；当前 Docker 与文档 CI 使用 Bun `1.4.4`，本地建议保持一致。插件和主题工具使用 JavaScript ZIP 库，不需要系统 `zip`。

```sh
git clone https://github.com/llleixx/picloom.git
cd picloom
bun install --frozen-lockfile
cp .env.example .env
```

主程序依赖 npm 精确版本，不需要工具链仓库或本地压缩包。仅在验证工具链源码修改时，从相邻的 `picloom-tooling` 执行 `bun run dev:sync -- ../picloom`；验证结束后切回 registry 版本并更新锁文件。详见[插件工具维护](./plugin-tooling-maintenance.md)。

这里使用仓库根目录的 `.env.example`，Docker 使用 `docker/.env.example`。

生成加密密钥：

```sh
bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将输出填入 `.env` 的 `ENCRYPTION_KEY`。设置 `INITIAL_OWNER_PASSWORD`，至少 6 个字符；可通过 `INITIAL_OWNER_USERNAME` 指定 Owner 用户名，留空默认为 `admin`，名称规则见[环境变量参考](../reference/settings.md#部署参数)。这两个初始配置仅在数据库尚无用户时生效，不会修改已有账号。

## 第一次启动

在服务尚未运行时执行：

```sh
bun run init-dev
bun run build:web
bun run dev
```

打开 `http://127.0.0.1:7425`，用上述账号登录，上传一张图片并打开返回的链接。

`init-dev` 创建开发用上传配置，不创建管理员：

| 项目 | 开发用配置 |
| --- | --- |
| 路径 | 内置随机路径插件 |
| 存储 | `DATA_DIR/originals` 下的本地目录 |
| 存储组与上传配置 | `Local` 存储组、`Default` 上传配置，公开前缀 `/i/` |
| 访问处理 | 为初始空流水线加入图片变换，开放 `w`、`h`、`fit`、`q`、`format` 参数 |

已有上传配置时，`init-dev` 直接返回，不重置配置。如果先启动过应用，它也不会再补入开发用配置。首次部署使用 `./images` 存储、空访问流水线，详见 [快速开始](../guide/quick-start.md)。

## 修改前端

`bun run dev` 监视后端代码，前端页面来自 `dist/web`。需要前端热更新时，保持后端运行，另开终端：

```sh
bun run dev:web
```

打开 `http://127.0.0.1:5173`。Vite 将 API 和图片请求代理到 `http://127.0.0.1:7425`。若后端改为 3001 端口，前端也要指定代理目标：

```sh
BACKEND_URL=http://127.0.0.1:3001 bun run dev:web
```

仅使用后端地址预览时，前端改动后需重新执行 `bun run build:web`。

## 修改与验证

先从 [架构与代码导航](./architecture.md) 找到业务入口，再选择相关测试。

| 改动 | 验证方式 |
| --- | --- |
| TypeScript 代码或接口 | `bun run typecheck`，再运行相关测试文件 |
| 后台调度 | `bun test tests/task-scheduling.test.ts` |
| 数据访问或表结构 | 按 [数据访问与初始化](./persistence.md) 验证两种数据库 |
| 前端页面 | `bun run build:web`，打开对应页面检查操作 |
| 插件示例 | `bun run build:examples` 与 `bun test tests/examples.test.ts` |
| 文档 | 按 [文档站维护](./docs.md) 构建并预览 |

`tests/helpers.ts` 提供独立临时目录中的应用 fixture，可用于业务测试；测试结束应关闭应用并释放资源。真实存储服务测试需要额外凭证，不能替代本地测试。

修改用户行为、配置或公共协议时，同步更新对应文档。不要为修复个人开发数据而绕过数据库结构校验。
