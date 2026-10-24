# 设置与环境变量

部署参数决定应用如何启动；Web「设置」调整运行中的网站、上传和缓存行为。下表中的 Web 字段是 API 名称，方便脚本调用；页面中的大小和时间输入会换算为相应单位。

## 在哪里配置

| 配置方式 | 适用内容 | 生效方式 |
| --- | --- | --- |
| 环境变量 | 密钥、数据库、监听地址，以及运行设置的初始值 | 部署参数在启动时读取；运行设置仅用于首次初始化 |
| Web「设置」 | 网站、域名、防盗链、缓存、游客额度、容量与并发 | 保存到 `DATA_DIR/site-settings.json`，立即应用并在重启后保留 |

**运行设置在首次启动时自动保存，之后从 `site-settings.json` 读取。** 这不要求先在 Web 点击保存。已有部署的域名、防盗链、上传限制和缓存等设置应在 Web 修改；重启或更改对应环境变量不会覆盖已保存值。密钥、数据库、监听地址等部署参数仍从环境变量读取，不受这个文件覆盖。已有站点缺少可信代理字段时，会将当前 `TRUSTED_PROXIES` 补入并保存；之后以 Web 设置为准，包括主动清空的列表。

Docker 使用 `docker/.env.example`，源码开发使用根目录的 `.env.example`。Compose 旁的 `.env` 用于替换 Compose 变量，不会自动把所有变量传入容器；额外变量需加入 Compose 的 `environment`。

首次创建站点配置时写入中英文名称 `Picloom`、简介“记录此刻，分享所见。”／“Capture the moment. Share what you see.”，以及 Logo、favicon 地址 `/assets/picloom.svg`。已有配置不补写；用户清空后的值保持为空。

## 部署参数

| 环境变量 | 默认或要求 | 用途 |
| --- | --- | --- |
| `ENCRYPTION_KEY` | 必填，64 位十六进制 | 加密插件凭证等敏感数据。保留原密钥，不能通过换一个值来轮换已保存数据的密钥 |
| `DATA_DIR` | 源码为 `./data`；Docker 为 `/var/lib/picloom/app` | 保存数据库、设置、插件和临时内容；不代表所有存储源图片都位于这里 |
| `DATABASE_URL` | 空 | 空值使用数据目录内的 SQLite，否则连接指定 PostgreSQL 数据库 |
| `HOST` / `PORT` | `127.0.0.1` / `7425` | HTTP 监听地址和端口；Docker 镜像监听 `0.0.0.0`，对外端口由 Compose 映射决定 |
| `INITIAL_OWNER_PASSWORD` | 空，指定时至少 6 字符 | 仅首次创建 Owner 时使用；留空会生成随机密码并打印，不能用于修改已有密码 |

密钥生成与目录映射见 [Docker 部署](../operations/deploy.md)，反代配置见 [域名与反向代理](../operations/proxy.md)。

## 网站与域名

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `enabledLocales` | 无环境变量，中英文 | 首页启用语言；第三方主题页使用它与主题支持语言的交集 |
| `defaultLocale` | 无环境变量，`en-US` | 无有效用户偏好及浏览器匹配时使用；必须已启用，且受当前启用主题支持 |
| `content` | 无环境变量，初始化中英文名称 `Picloom` 及简介 | 按语言代码保存 `name`、`description`；只读取当前语言，缺失或为空返回空字符串 |
| `siteLogoUrl` | 无环境变量，初始化 `/assets/picloom.svg` | Logo 的 HTTP(S) 地址或内置图标路径；留空不显示 |
| `siteFaviconUrl` | 无环境变量，初始化 `/assets/picloom.svg` | 浏览器标签页图标地址；留空不加载替代资源 |
| `publicOrigin` | `PUBLIC_ORIGIN`，空 | 网站来源，如 `https://pic.example.com`；用于来源检查和链接生成，留空时普通请求使用当前来源 |
| `trustedProxies` | `TRUSTED_PROXIES`，空列表 | 可信代理 IP 或 CIDR；Web 每行一个，环境变量用逗号分隔。仅信任这些来源传入的 `X-Real-IP`，代理必须覆盖该请求头 |
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
| `chunkThresholdBytes` | `CHUNK_THRESHOLD_BYTES=8388608`（8 MiB） | Web 上传器切换到分片上传的阈值 |
| `chunkPartBytes` | `CHUNK_PART_BYTES=4194304`（4 MiB） | 新分片会话的分片大小；已有会话仍使用创建时的值 |

大小字段以字节保存，`1 MiB = 1048576` 字节。普通上传与分片上传均受单文件大小限制；分片阈值只决定 Web 上传器使用哪种传输方式。

## 并发与图片处理

| Web 字段 | 环境变量 / 默认 | 用途 |
| --- | --- | --- |
| `uploadConcurrency` | `UPLOAD_CONCURRENCY=4` | 上传接收与完成处理的并发名额，也提供给 Web 上传器作为文件并发值 |
| `partConcurrency` | `PART_CONCURRENCY=2` | 单个分片会话同时接收的分片数，也提供给 Web 上传器 |
| `processingConcurrency` | `PROCESSING_CONCURRENCY=2` | 上传流水线与派生图片处理共用的并发数 |
| `processingQueue` | `PROCESSING_QUEUE=16` | 上述图片处理可排队的工作数，满时拒绝新工作 |
| `writeConcurrency` | `WRITE_CONCURRENCY=4` | 存储写入并发数，包含上传、剩余副本写入和重试；优先推进尚无成功副本的上传 |
| `postSaveConcurrency` | `POST_SAVE_CONCURRENCY=2` | 上传后处理并发数，每条完整保存后流水线占一个名额 |
| `deleteConcurrency` | `DELETE_CONCURRENCY=2` | 删除并发数，每次远端副本删除占一个名额 |
| `retryLimit` | `RETRY_LIMIT=5` | 可自动重试任务的总尝试次数，包含首次执行；不强制重试不可重试的错误 |
| `maxDimension` | `MAX_DIMENSION=8192` | 处理插件的单边尺寸上限，核心也用于校验处理输出 |
| `maxPixels` | `MAX_PIXELS=40000000` | 图片总像素上限，限制解码和处理规模 |

这些值作用在不同环节，不应全部同时调高。具体预算关系见 [容量与并发](../operations/resources.md)；变换参数见 [图片处理插件](./plugins/sharp.md)。

## 站点语言与内容

当前支持简体中文（`zh-CN`）和英文（`en-US`）。内置首页使用 `enabledLocales`，内置登录页和后台使用核心支持的全部语言。第三方主题首页和登录页均使用站点启用语言与主题支持语言的交集，后台不受主题限制。语言依次取用户显式选择、浏览器偏好列表中第一个匹配项、`defaultLocale`。未手动选择时自动匹配浏览器语言；语言选择器只列出可用语言。页面暂时不支持用户偏好时不会覆盖该偏好。

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

字段只读取当前语言的实际值，不使用基础语言、站点默认语言或内置文案填补。上述示例在英文界面的网站名称为空。默认名称、简介和图标只在新站点初始化时保存；主动清空后不会重新补入。停用语言不会删除其内容。后台的内容语言选择仅决定编辑哪份内容，不改变界面语言。

开发者新增语言时，在 `shared/locales.ts` 注册语言与匹配规则，并在 `web/src/lib/i18n.ts` 注册对应文案资源；业务页面通过 `t()` 获取文案，不添加语言分支。独立主题工具的预览语言示例在 `picloom-tooling/tools/theme-tools/src/locales.ts` 维护，随目标宿主版本同步检查，不作为 SDK 的固定语言范围。

主题清单的 `defaultLocale` 仅用于包内名称、字段标签和功能字典回退，与这里的站点默认语言职责不同，也不会让管理员填写的配置值回退。详见[主题开发](../development/themes.md)。
