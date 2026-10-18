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

访问 `http://localhost:3000`，用 `admin` 和初始密码登录。远程部署时将 `localhost` 换成服务器地址。

若初始密码留空，首次启动会生成随机密码，可通过 `docker compose logs picloom` 查看。修改该变量不会重置已有账户密码。

数据保存在 Compose 文件旁的 `data/` 目录中：`app/` 保存应用数据和本地图片，`backups/` 保存内置备份。重建容器时保留 `data/` 即可。正式对外提供服务前配置 [HTTPS 与域名](../operations/proxy.md)。其他部署方式见 [Docker 部署](../operations/deploy.md)。

## 2. 配置存储源

打开 **配置 → 存储源**，创建一个本地存储源：

- 插件：本地存储。
- 名称：本地图片。
- 根目录：`./images`。

相对目录以应用数据目录为起点，因此图片保存在宿主机的 `./data/app/images`。保存后确认存储源显示“就绪”。

## 3. 配置存储组

打开 **配置 → 存储组**，新建“本地组”：

- 添加刚才的存储源。
- 主存储选择使用优先级。
- 冗余数量设为 `0`。

只有一个存储源时，不需要配置冗余。

## 4. 配置上传入口

打开 **配置 → 上传配置**，新建“默认上传”：

- 公开前缀：`/i/`。
- 路径插件：随机路径（默认），目录层数保留 `2`。
- 存储组：本地组。
- 保持启用，先不开放游客上传。
- 上传处理、保存后处理先留空。

首次部署需要手动创建存储源、存储组和上传配置。

## 5. 上传并访问

回到上传页，选择“默认上传”，上传一张 JPEG 或 PNG 图片。复制返回的链接，用新标签页打开。

在图片管理页可以查看该文件。任何获得公开链接的人都可以访问图片，无需登录。

日常上传、粘贴图片链接和复制 Markdown 的方法见 [上传与分享](./upload.md)。

配置之间的关系见 [理解 Picloom](./concepts.md)。想让链接支持 `?w=320&format=webp`，再按 [缩略图场景](./recipes.md#访问时生成缩略图) 配置访问流水线。
