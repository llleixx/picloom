# Docker 部署

单实例优先使用 SQLite。需要 PostgreSQL 时选择单独的 Compose 文件；两者不是在线切换数据库的工具。

## SQLite

按 [快速开始](../guide/quick-start.md) 下载部署文件并准备 `.env` 与数据目录，然后执行：

```sh
docker compose -f compose.yml up -d
```

默认使用 `llleixx/picloom:latest`。如果镜像尚未发布或需要运行当前源码，需要另行取得源码，在仓库根目录构建同名镜像，再回到部署目录启动：

```sh
docker build -t llleixx/picloom:latest .
docker compose -f compose.yml up -d --pull never
```

## PostgreSQL

下载 PostgreSQL 部署文件：

```sh
curl -fL https://raw.githubusercontent.com/llleixx/picloom/main/compose.postgres.yml -o compose.postgres.yml
```

在同一份 `.env` 中额外设置 `POSTGRES_PASSWORD`。推荐用 `openssl rand -hex 32` 生成独立密码，因为它会进入数据库连接 URL。

```sh
docker compose -f compose.postgres.yml up -d
```

此配置会启动专用 PostgreSQL 数据库。即使使用 PostgreSQL，也必须保留 `./data` 目录，其中包含插件、设置和可能的本地图片。

不要让多个 Picloom 进程共用同一数据目录。本项目当前按单进程运行和协调后台工作。

## 数据与端口

| 项目         | 默认值                                 |
| ------------ | -------------------------------------- |
| 宿主机端口   | `3000`，可用 `HTTP_PORT` 修改          |
| 绑定地址     | `0.0.0.0`，可用 `PUBLISH_ADDRESS` 修改 |
| 数据总目录 | `./data` → `/var/lib/picloom` |
| 应用数据 | 宿主机 `./data/app` |
| 内置备份 | 宿主机 `./data/backups` |
| PostgreSQL 数据 | `./postgres` → `/var/lib/postgresql/data` |
| 容器数据目录 | `/var/lib/picloom/app`                |

使用本机反向代理时，将 `PUBLISH_ADDRESS` 设为 `127.0.0.1`。日志与状态：

```sh
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 picloom
```

使用 PostgreSQL 时将以上文件名替换为 `compose.postgres.yml`。

上述目录布局用于新部署。已有部署应保留原挂载和 `DATA_DIR`；切换布局需要迁移数据及已保存的存储路径，修改 Compose 不会自动完成迁移。
