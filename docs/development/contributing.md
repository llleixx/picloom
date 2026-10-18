# 本地开发与贡献

当前 Docker 构建使用 Bun `1.4.3`；本地建议使用相同版本。需要 Git，构建插件示例另需 `zip`。

## 启动

```sh
bun install --frozen-lockfile
cp .env.example .env
bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

将生成值填入 `.env` 的 `ENCRYPTION_KEY`，设置 `INITIAL_OWNER_PASSWORD`。在服务未运行时初始化开发用配置：

```sh
bun run init-dev
bun run build:web
bun run dev
```

`init-dev` 创建本地存储、使用随机路径的默认上传配置与访问图片变换，用于本地开发。首次部署的默认配置见 [快速开始](../guide/quick-start.md)。

后端默认监听 `127.0.0.1:3000`。修改前端时可另开终端执行 `bun run dev:web`，使用 Vite 输出的地址。

## 检查改动

```sh
bun run typecheck
bun test tests/task-scheduling.test.ts
```

按改动选择相关测试文件，不必为文字修改运行全部后端测试。涉及插件示例时执行 `bun run build:examples`；涉及文档时见 [文档站维护](./docs.md)。

## 修改边界

- HTTP 层负责认证、参数解析和响应；业务规则放在核心层。
- 数据访问通过持久化接口，注意同时兼容 SQLite 与 PostgreSQL。
- 内置插件不得使用外部插件无法获得的特殊业务接口。
- 修改配置、协议或用户行为时，在同一 PR 更新对应文档和必要测试。

当前开发阶段的初始结构有校验。不要为了让个人数据目录启动而提交绕过结构校验的代码。
