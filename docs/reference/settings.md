# 设置与环境变量

部署参数决定应用如何启动；Web「设置」调整运行中的网站、上传和缓存行为。下表中的 Web 字段是 API 名称，方便脚本调用；页面中的大小和时间输入会换算为相应单位。

## 在哪里配置

| 配置方式 | 适用内容 | 生效方式 |
| --- | --- | --- |
| 环境变量 | 密钥、数据库、监听地址，以及运行设置的初始值 | 启动时读取，修改后需重启 |
| Web「设置」 | 网站、域名、防盗链、缓存、游客额度、容量与并发 | 保存到 `DATA_DIR/delivery-settings.json`，立即应用并在重启后保留 |

**已保存的 Web 设置覆盖对应环境默认值。** 修改 `.env` 后没有变化时，先检查是否已在 Web 保存过设置。部署参数不受这个文件覆盖。

Docker 使用 `docker/.env.example`，源码开发使用根目录的 `.env.example`。Compose 旁的 `.env` 用于替换 Compose 变量，不会自动把所有变量传入容器；额外变量需加入 Compose 的 `environment`。

## 部署参数

| 环境变量 | 默认或要求 | 用途 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | 必填，64 位十六进制 | 加密插件凭证等敏感数据。保留原密钥，不能通过换一个值来轮换已保存数据的密钥 |
| `DATA_DIR` | 源码为 `./data`；Docker 为 `/var/lib/picloom/app` | 保存数据库、设置、插件和临时内容；不代表所有存储源图片都位于这里 |
| `DATABASE_URL` | 空 | 空值使用数据目录内的 SQLite，否则连接指定 PostgreSQL 数据库 |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | HTTP 监听地址和端口；Docker 镜像监听 `0.0.0.0`，对外端口由 Compose 映射决定 |
| `INITIAL_OWNER_PASSWORD` | 空，指定时至少 6 字符 | 仅首次创建 Owner 时使用；留空会生成随机密码并打印，不能用于修改已有密码 |
| `TRUSTED_PROXIES` | 空 | 逗号分隔的可信代理 IP 或 CIDR；仅信任这些来源传入的 `X-Real-IP` |

密钥生成与目录映射见 [Docker 部署](../operations/deploy.md)，反代配置见 [域名与反向代理](../operations/proxy.md)。

## 网站与域名

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `enabledLocales` | 无环境变量，中英文 | 首页启用语言；仅一种时隐藏语言选择器 |
| `defaultLocale` | 无环境变量，`en-US` | 浏览器语言无法匹配时的兜底，也用于站点内容回退；必须已启用 |
| `content` | 无环境变量，`{}` | 按语言代码保存 `name`、`description`；当前语言未填写时依次使用基础语言、默认语言、内置文案 |
| `siteLogoUrl` | 无环境变量，空 | 自定义 Logo 的 HTTP(S) 图片地址；留空使用默认图标 |
| `siteFaviconUrl` | 无环境变量，空 | 浏览器标签页图标地址；留空使用默认图标 |
| `publicOrigin` | `PUBLIC_ORIGIN`，空 | 网站来源，如 `https://pic.example.com`；用于来源检查和链接生成，留空时普通请求使用当前来源 |
| `imageOrigin` | `IMAGE_ORIGIN`，跟随网站来源 | 独立图片域名；为空时使用网站来源，再回退到当前请求来源 |

域名字段只填协议和主机，不带路径。后台任务没有当前请求来源，需要生成完整图片 URL 时应配置域名，例如使用 URL 模式审核。

## 防盗链

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `hotlinkEnabled` | `HOTLINK_ENABLED=false` | 是否根据请求的 Referer 限制图片访问 |
| `hotlinkAllowedHosts` | `HOTLINK_ALLOWED_HOSTS`，空列表 | 允许引用图片的主机名；支持 `*.example.com`，该写法仅匹配子域名 |
| `hotlinkAllowEmpty` | `HOTLINK_ALLOW_EMPTY=true` | 允许不带 Referer 的请求，例如直接打开图片链接 |

网站和图片域名自动允许。Web 使用主机名列表，环境变量使用逗号分隔；不要填写完整 URL。防盗链不是身份认证，详见 [域名与反向代理](../operations/proxy.md)。

## 缓存

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `uploadTempBytes` | `UPLOAD_TEMP_BYTES=1073741824`（1 GiB） | 临时缓存总预算：上传分片、合并、处理中间结果及后台所需源文件，包含空间预留 |
| `cacheBytes` | `CACHE_BYTES=1073741824`（1 GiB） | 派生缓存上限，保存可重新生成的访问结果；空间不足时淘汰缓存，过大的单项不写入缓存 |
| `cacheTtlMs` | `CACHE_TTL_MS=86400000`（24 小时） | 派生缓存保留时间；过期内容由缓存机制清理 |
| `imageCacheMaxAge` | `IMAGE_CACHE_MAX_AGE=300`（5 分钟） | 控制浏览器和 CDN 的新鲜度；`0` 要求重新验证，正值可能使已删除图片在客户端继续显示至缓存到期 |

临时缓存与派生缓存使用独立预算，不是进程内存上限。临时预算不足会拒绝新工作，不会删除仍被使用的文件腾空间。浏览器与 CDN 缓存控制的是客户端行为，不占用上述服务器缓存预算。

## 游客与上传

游客是否允许上传、可用哪些上传配置，在各上传配置的授权中设置。以下两项只限制额度，不负责开放游客权限。

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `guestMaxUploadBytes` | 无环境变量，空 | 游客单文件大小上限；空值跟随全局上限 |
| `guestDailyUploadLimit` | 无环境变量，空 | 按游客 IP、UTC 日期计算的每日上传次数；空值不另设每日额度，`0` 禁止上传 |
| `maxUploadBytes` | `MAX_UPLOAD_BYTES=20971520`（20 MiB） | 全局单文件上限，还需同时满足用户与上传配置的限制 |
| `uploadSessionLimit` | `UPLOAD_SESSION_LIMIT=100` | 允许同时存在的待完成／完成中分片会话数量 |
| `uploadSessionTtlMs` | `UPLOAD_SESSION_TTL_MS=86400000`（24 小时） | 从创建起计算的分片会话有效期，超期不能续传 |
| `chunkThresholdBytes` | `CHUNK_THRESHOLD_BYTES=8388608`（8 MiB） | Web 上传器切换到分片上传的阈值；客户端得到的值不会超过普通上传的 20 MiB 上限 |
| `chunkPartBytes` | `CHUNK_PART_BYTES=4194304`（4 MiB） | 新分片会话的分片大小；已有会话仍使用创建时的值 |

大小字段以字节保存，`1 MiB = 1048576` 字节。普通 multipart 上传另有固定的 20 MiB 文件上限，提高全局上限不会解除它；大文件使用 [分片上传](./http-api.md#分片上传)。

## 并发与图片处理

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `uploadConcurrency` | `UPLOAD_CONCURRENCY=4` | 上传接收与完成处理的并发名额，也提供给 Web 上传器作为文件并发值 |
| `partConcurrency` | `PART_CONCURRENCY=2` | 单个分片会话同时接收的分片数，也提供给 Web 上传器 |
| `processingConcurrency` | `PROCESSING_CONCURRENCY=2` | 上传流水线与派生图片处理共用的并发数 |
| `processingQueue` | `PROCESSING_QUEUE=16` | 上述图片处理可排队的工作数，满时拒绝新工作 |
| `taskConcurrency` | `TASK_CONCURRENCY=4` | 后台冗余写入、保存后处理、删除任务共用的执行名额 |
| `retryLimit` | `RETRY_LIMIT=5` | 可自动重试任务的总尝试次数，包含首次执行；不强制重试不可重试的错误 |
| `maxDimension` | `MAX_DIMENSION=8192` | 处理插件的单边尺寸上限，核心也用于校验处理输出 |
| `maxPixels` | `MAX_PIXELS=40000000` | 图片总像素上限，限制解码和处理规模 |

这些值作用在不同环节，不应全部同时调高。具体预算关系见 [容量与并发](../operations/resources.md)；变换参数见 [图片处理插件](./plugins/sharp.md)。

## 站点语言与内容

当前支持简体中文（`zh-CN`）和英文（`en-US`）。首页使用 `enabledLocales`，登录页和后台使用程序支持的全部语言。语言依次取用户显式选择、浏览器偏好列表中第一个匹配项、`defaultLocale`。未手动选择时自动匹配浏览器语言；语言选择器只列出可用语言。页面暂时不支持用户偏好时不会覆盖该偏好。

站点名称和简介按语言保存，例如：

```json
{
  "enabledLocales": ["zh-CN", "en-US"],
  "defaultLocale": "zh-CN",
  "content": {
    "zh-CN": { "name": "拾光图床", "description": "收集和分享生活中的图片" },
    "en-US": { "description": "Collect and share moments from your life." }
  }
}
```

字段逐个回退：当前语言、基础语言（如 `zh`）、默认语言、内置文案。空白文本视为未填写。更换默认语言只改变回退来源；停用语言不会删除其内容。后台的内容语言选择仅决定编辑哪份内容，不改变界面语言。

开发者新增语言时，在 `shared/locales.ts` 注册语言及匹配规则，并在 `web/src/lib/i18n.ts` 注册对应文案资源；业务页面通过 `t()` 获取文案，不添加语言分支。
