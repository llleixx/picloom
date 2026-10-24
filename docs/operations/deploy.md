# Docker 部署

## 选择数据库

| 方案 | 适用情况 | 宿主机数据目录 | 内置备份 |
| --- | --- | --- | --- |
| SQLite（推荐） | 常规单实例部署 | `./data` | 支持 |
| PostgreSQL | 需要使用 PostgreSQL | `./data` 和 `./postgres` | 不支持，需使用数据库工具备份 |

两种方案均运行一个 Picloom 实例，不要让多个实例共用同一数据目录。更换 Compose 文件不会迁移数据库。

## 使用 SQLite

按 [快速开始](../guide/quick-start.md) 下载部署文件、配置密钥并启动服务即可，无需额外配置数据库。

## 使用 PostgreSQL

安装 Docker Compose 后，创建部署目录并下载文件：

```sh
mkdir picloom
cd picloom
curl -fL https://raw.githubusercontent.com/llleixx/picloom/main/compose.postgres.yml -o compose.yml
curl -fL https://raw.githubusercontent.com/llleixx/picloom/main/docker/.env.example -o .env
```

编辑 `.env`：

- `ENCRYPTION_KEY`：加密密钥，升级和恢复时保留原值。推荐用 `openssl rand -hex 32` 生成。
- `INITIAL_OWNER_PASSWORD`：初始管理员密码，至少 6 个字符。
- `POSTGRES_PASSWORD`：数据库密码，使用与加密密钥不同的值。

数据库密码会写入连接 URL，推荐另行执行以下命令生成，避免特殊字符需要转义：

```sh
openssl rand -hex 32
```

启动服务，Compose 会同时启动 PostgreSQL，并等待数据库就绪后启动 Picloom：

```sh
docker compose up -d
```

访问 `http://localhost:7425`，用 `admin` 和初始密码登录。远程部署时将 `localhost` 换成服务器地址。默认存储与上传配置见 [快速开始](../guide/quick-start.md#_2-查看默认配置)。

## 数据存在哪里

以下宿主机路径均相对于 Compose 文件所在目录。两种方案都将 `./data` 挂载到容器的 `/var/lib/picloom`，其中包含应用数据和备份两个子目录：

| 宿主机路径 | 容器内路径 | 用途 |
| --- | --- | --- |
| `./data/app` | `/var/lib/picloom/app` | 应用数据；默认本地图片位于其中的 `images/` |
| `./data/backups` | `/var/lib/picloom/backups` | 内置备份，仅 SQLite 方案使用 |
| `./postgres` | `/var/lib/postgresql/data` | PostgreSQL 数据，仅 PostgreSQL 方案使用 |

PostgreSQL 只替代数据库，插件、运行设置和本地图片仍需保存在 `./data`。重建容器时保留这些目录及原有 `.env`；额外挂载的本地图片目录也需要保留。

已有部署应保留原挂载和 `DATA_DIR`。调整目录布局需要迁移数据及已保存的存储路径，修改 Compose 不会自动迁移。

备份范围与恢复步骤见 [数据、备份与升级](./data.md)。

## 调整端口与访问地址

在 `.env` 中修改：

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `HTTP_PORT` | `7425` | 宿主机访问端口，容器内仍使用 `7425` |
| `PUBLISH_ADDRESS` | `0.0.0.0` | 宿主机监听地址，默认监听所有 IPv4 接口 |

如果 Nginx 运行在同一宿主机上，可设为：

```dotenv
PUBLISH_ADDRESS=127.0.0.1
HTTP_PORT=7425
```

此时只能通过宿主机本地端口或反向代理访问。域名、HTTPS 与可信代理设置见 [域名与反向代理](./proxy.md)。

修改 `.env` 后，在部署目录执行 `docker compose up -d` 应用配置。`INITIAL_OWNER_PASSWORD` 只在首次初始化时生效，不能用于重置已有账户密码。

## 日常管理

在部署目录执行：

```sh
# 查看状态
docker compose ps

# 查看最近 100 行日志
docker compose logs --tail=100 picloom

# 停止服务（PostgreSQL 方案会同时停止数据库）
docker compose stop

# 启动服务
docker compose up -d
```

更新镜像前先备份，具体步骤见 [升级](./data.md#升级)。

## 从源码构建镜像（可选）

需要运行源码版本时，在部署目录之外获取源码，并在仓库根目录构建镜像：

```sh
git clone https://github.com/llleixx/picloom.git picloom-src
cd picloom-src
docker build -t llleixx/picloom:latest .
```

构建后回到保存 `compose.yml` 和 `.env` 的部署目录，使用本地镜像重建服务：

```sh
docker compose up -d --pull never --force-recreate
```

源码目录用于构建，部署目录用于保存配置和数据，两者无需放在一起。
