# 设置与环境变量

Docker 部署使用 `docker/.env.example`，下载为 Compose 文件旁的 `.env`；本地开发使用仓库根目录的 `.env.example`。

## 优先级

启动时读取环境默认值，再加载 `DATA_DIR/delivery-settings.json`。Web 设置保存到该文件，**覆盖对应环境默认值**，并应用到当前进程。

`ENCRYPTION_KEY`、数据库连接、数据目录和监听参数属于部署配置，不在 Web 设置里修改。Docker 只传入 Compose 中列出的变量；想额外传入变量，需要修改 Compose 的 `environment`。

## 部署配置

| 环境变量                 | 默认或要求           | 用途                                              |
| ------------------------ | -------------------- | ------------------------------------------------- |
| `ENCRYPTION_KEY`         | 必填，64 位十六进制  | 32 字节加密密钥                                   |
| `DATA_DIR`               | 源码运行时 `./data`  | 数据目录；Docker 为 `/var/lib/picloom/app`       |
| `DATABASE_URL`           | 空                   | 空值使用 SQLite；否则为专用 PostgreSQL 数据库连接 |
| `HOST` / `PORT`          | `127.0.0.1` / `3000` | 源码运行监听；Docker 监听 `0.0.0.0`               |
| `INITIAL_OWNER_PASSWORD` | 空                   | 首次启动随机生成；指定值至少 6 字符              |
| `TRUSTED_PROXIES`        | 空                   | 可信代理 IP，逗号分隔                             |

## 域名与访问

| 环境默认值              | Web 字段              | 默认                           |
| ----------------------- | --------------------- | ------------------------------ |
| `PUBLIC_ORIGIN`         | `publicOrigin`        | 当前请求来源；后台无请求上下文 |
| `IMAGE_ORIGIN`          | `imageOrigin`         | 跟随站点来源                   |
| `HOTLINK_ENABLED`       | `hotlinkEnabled`      | `false`                        |
| `HOTLINK_ALLOWED_HOSTS` | `hotlinkAllowedHosts` | 空列表                         |
| `HOTLINK_ALLOW_EMPTY`   | `hotlinkAllowEmpty`   | `true`                         |
| `IMAGE_CACHE_MAX_AGE`   | `imageCacheMaxAge`    | `300` 秒（5 分钟）     |

## 容量与并发

大小均为字节；下表用 MiB/GiB 表示便于阅读的默认值。

| 环境默认值               | Web 字段                | 默认                     |
| ------------------------ | ----------------------- | ------------------------ |
| `MAX_UPLOAD_BYTES`       | `maxUploadBytes`        | 20 MiB                   |
| `UPLOAD_TEMP_BYTES`      | `uploadTempBytes`       | 1 GiB                    |
| `CACHE_BYTES`            | `cacheBytes`            | 1 GiB                    |
| `CACHE_TTL_MS`           | `cacheTtlMs`            | 86400000 毫秒（24 小时） |
| `UPLOAD_SESSION_LIMIT`   | `uploadSessionLimit`    | 100                      |
| `UPLOAD_SESSION_TTL_MS`  | `uploadSessionTtlMs`    | 86400000 毫秒            |
| `CHUNK_THRESHOLD_BYTES`  | `chunkThresholdBytes`   | 8 MiB                    |
| `CHUNK_PART_BYTES`       | `chunkPartBytes`        | 4 MiB                    |
| `UPLOAD_CONCURRENCY`     | `uploadConcurrency`     | 2                        |
| `PART_CONCURRENCY`       | `partConcurrency`       | 2                        |
| `PROCESSING_CONCURRENCY` | `processingConcurrency` | 2                        |
| `PROCESSING_QUEUE`       | `processingQueue`       | 16                       |
| `TASK_CONCURRENCY`       | `taskConcurrency`       | 2                        |
| `RETRY_LIMIT`            | `retryLimit`            | 5 次尝试                 |
| `MAX_DIMENSION`          | `maxDimension`          | 8192 像素                |
| `MAX_PIXELS`             | `maxPixels`             | 40000000 像素            |

分片上传与直接上传的接口限制见 [HTTP API](./http-api.md)。大小上限不等于进程内存上限，见 [容量与并发](../operations/resources.md)。

游客大小、游客每日额度和站点名称、说明、Logo、图标在 Web 设置中配置。当前没有游客分钟限流项。

约束与完整字段以 [`src/config.ts`](https://github.com/llleixx/picloom/blob/main/src/config.ts)、[`shared/runtime-settings.ts`](https://github.com/llleixx/picloom/blob/main/shared/runtime-settings.ts) 和 [`shared/api.ts`](https://github.com/llleixx/picloom/blob/main/shared/api.ts) 为准。
