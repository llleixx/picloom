# 快速开始

本节使用 Docker Compose 和本地存储部署 Picloom，完成第一张图片的上传。

## 1. 启动服务

安装 Docker Compose 后，创建目录并下载部署文件：

```sh
mkdir picloom
cd picloom
curl -fL https://raw.githubusercontent.com/llleixx/picloom/main/compose.sqlite.yml -o compose.yml
curl -fL https://raw.githubusercontent.com/llleixx/picloom/main/docker/.env.example -o .env
```

编辑 `.env`，填写 `ENCRYPTION_KEY`。推荐用以下命令生成密钥，升级和恢复时保留原值：

```sh
openssl rand -hex 32
```

设置 `INITIAL_OWNER_PASSWORD` 为初始管理员密码，至少 6 个字符。

启动服务：

```sh
docker compose up -d
```

访问 `http://localhost:7425`，用 `admin` 和初始密码登录。远程部署时将 `localhost` 换成服务器地址。

若初始密码留空，首次启动会生成随机密码，可通过 `docker compose logs picloom` 查看。修改该变量不会重置已有账户密码。

数据保存在 Compose 文件旁的 `data/` 目录中：`app/` 保存应用数据和本地图片，`backups/` 保存内置备份。重建容器时保留 `data/` 即可。正式对外提供服务前配置 [HTTPS 与域名](../operations/proxy.md)。其他部署方式见 [Docker 部署](../operations/deploy.md)。

## 2. 查看默认配置

首次启动会创建以下配置，名称均为 `Default`，登录后即可上传：

| 配置入口 | 默认设置 |
| --- | --- |
| 配置 → 存储源 | 本地存储，根目录 `./images`，对应宿主机 `./data/app/images` |
| 配置 → 存储组 | 使用上述存储源，按优先级选择存储目标，副本数为 `1`，即只保存一份 |
| 配置 → 上传配置 | 公开前缀 `/i/`，使用随机路径，分片目录层数为 `2`，关联上述存储组并启用 |

上传和保存后流水线留空，全局访问流水线没有处理步骤，游客上传默认关闭。可在上述入口查看或调整配置；需要其他存储时，见 [存储源与存储组](./storage.md)。

默认配置仅在首次初始化时创建。升级不会向已有部署补建，删除后也不会自动恢复。

## 3. 上传并访问

回到上传页，选择 `Default`，上传一张 JPEG 或 PNG 图片。复制返回的链接，用新标签页打开。

在图片管理页可以查看该文件。任何获得公开链接的人都可以访问图片，无需登录。

上传页也支持拖拽、粘贴图片或公开图片直链；上传结果可复制为 URL、Markdown、HTML 或 BBCode。

配置之间的关系见 [理解 Picloom](./concepts.md)。想让链接支持 `?w=320&format=webp`，再按 [缩略图场景](./recipes.md#用同一张原图生成不同尺寸) 配置访问流水线。
