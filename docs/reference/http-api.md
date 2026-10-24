# HTTP API

脚本上传使用上传令牌；管理图片与配置使用登录会话；分片会话创建后使用独立密钥。公开图片链接不是管理接口。

## 认证方式

| 凭证 | 用途 | 携带方式 |
| --- | --- | --- |
| 上传令牌 | 查询可用上传配置、上传文件、从 URL 上传、创建分片会话 | `Authorization: Bearer <token>` |
| 登录会话 | 管理操作，也可用于上传 | 登录返回的 Cookie；非 GET/HEAD 请求另带 `X-CSRF-Token` |
| 分片密钥 | 写分片、查询进度、完成或取消该会话 | `X-Upload-Key: <uploadKey>` |
| 无凭证 | 公开图片、客户端设置，以及已授权的游客上传 | 不携带认证信息 |

`GET /api/upload-profiles` 接受上传令牌或登录会话；令牌查询仅返回账号权限与令牌范围的交集。匿名查询返回游客可见配置。上传令牌不能调用管理 API，无效凭证不会自动降级为游客。

API 请求如果携带 `Origin`，必须与配置的网站来源匹配；未配置时与请求来源匹配。

## 上传一张图片

先创建 [上传令牌](../guide/access.md#上传令牌)。以下命令在 Bash 中执行，需要 curl；将地址和令牌替换为实际值，查询允许使用的上传配置：

```sh
export PICLOOM_URL='https://pic.example.com'
export PICLOOM_TOKEN='YOUR_UPLOAD_TOKEN'
curl --fail-with-body "$PICLOOM_URL/api/upload-profiles" \
  -H "Authorization: Bearer $PICLOOM_TOKEN"
```

响应为配置数组，选择 `available: true` 的条目，将其 `id` 填入下方变量。也可在管理界面的「上传配置」页面点击「复制 ID」，但该配置仍需在令牌权限范围内。当前目录准备 `photo.jpg`，执行上传：

```sh
export PICLOOM_PROFILE_ID='YOUR_PROFILE_ID'

curl --fail-with-body "$PICLOOM_URL/api/files" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -F "profileId=$PICLOOM_PROFILE_ID" \
  -F 'file=@photo.jpg'
```

`POST /api/files` 接收 multipart 表单，每次一张图片：

| 字段 | 必填 | 内容 |
| --- | --- | --- |
| `profileId` | 否 | 上传配置 ID；省略时使用当前用户默认，否则使用站点默认。显式填写时不能使用显示名称代替 |
| `file` | 是 | 图片文件 |
| `organization` | 否 | 初始归类 JSON 字符串，例如 `{"tagIds":["TAG_ID"],"collectionIds":["COLLECTION_ID"]}` |
| `params` | 否 | JSON 字符串，例如 `{"w":1600}`；对应参数必须已在上传流水线步骤中开放 |

在管理界面「标签」或「集合」页面复制分类 ID 后，可增加：

```sh
-F 'organization={"tagIds":["YOUR_TAG_ID"],"collectionIds":["YOUR_COLLECTION_ID"]}'
```

`organization` 是核心字段，与插件 `params` 分开。URL 上传和分片创建在 JSON 中传同结构对象；省略表示初始无归类。会话用户及令牌只能选择自己范围的已有分类，访客图片不支持归类。上传处理及保存后处理可以继续调整注册用户图片的最终归类。分片固定创建时的 ID，完成前目标被删除会明确失败。

需要参数时在命令中增加 `-F 'params={"w":1600}'`。让 curl 自动设置 multipart 的 Content-Type 和 boundary。

成功返回 HTTP `201`：

```json
{
  "id": "c95011dd-dba9-416d-a7b4-2812b2f7e87c",
  "url": "https://img.example.com/i/9b7c6d5e4f304162a8b9c0d1e2f34567.jpg"
}
```

`url` 用于分享，`id` 用于管理。至少一份副本此时已写入并完成发布，其他副本写入与保存后处理可能仍在执行。

普通上传大小受全局、用户和上传配置限制，文本字段单项不超过 64 KiB；`params` 另限 8192 字符。大文件可使用分片接口，避免中断后重传整个文件。

### 请求参数的值

请求参数由插件的 `paramsSchema` 声明，并由管理员在相应上传或访问步骤中逐项启用。未声明或未启用的参数不会传给插件；省略参数时服务端不补 Schema 默认值。

上传 `params` 中使用实际 JSON 标量，例如 `{ "label": "", "enabled": false, "count": 0 }`；数值字段不能传成 `"0"`，布尔字段不能传成 `"false"`。访问处理参数放在图片 URL 的查询字符串中，例如 `?label=&enabled=false&count=0`；数值按声明类型解析，布尔值只接受 `true/false`，同一个已启用的标量参数不能重复传入。空字符串、`false` 和 `0` 都表示已传值，只有缺失才省略。

## 从 URL 上传

`POST /api/files/from-url` 接收 JSON，成功返回同样的 `201`、`id` 和 `url`。本例还需要 jq，用于安全构造 JSON：

```sh
jq -n --arg profile "$PICLOOM_PROFILE_ID" \
  --arg url 'https://example.com/photo.jpg' \
  '{profileId: $profile, url: $url}' |
  curl --fail-with-body "$PICLOOM_URL/api/files/from-url" \
    -H "Authorization: Bearer $PICLOOM_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-
```

远端地址需通过服务器的地址和大小校验。此接口不接收自定义 `params`，使用上传流水线的固定配置；它不是对任意内网地址的下载代理。

## 分片上传

分片是同一个文件的传输单元，上传完全部分片后才进入处理与存储流程。

| 步骤 | 请求 | 输入 / 成功响应 |
| --- | --- | --- |
| 创建 | `POST /api/uploads` | JSON：`size`，可选 `profileId`、`name`、`params`、`organization`；返回 `201` |
| 写分片 | `PUT /api/uploads/:id/parts/:index` | 原始字节；返回 `200`、`{"ok":true}` |
| 查进度 | `GET /api/uploads/:id` | 返回会话状态、`partSize`、`expiresAt`、已接收索引 `parts` |
| 完成 | `POST /api/uploads/:id/complete` | 返回 `200` 和最终文件的 `id`、`url` |
| 取消 | `DELETE /api/uploads/:id` | 返回 `200`、`{"ok":true}` |

创建时 `size` 是文件总字节数，`params` 是 JSON 对象，区别于 multipart 中的 JSON 字符串。创建响应：

```json
{
  "id": "32ceaf62-d429-4f72-b370-5b246024162c",
  "uploadKey": "SESSION_SECRET",
  "partSize": 4194304,
  "expiresAt": 1792368000000
}
```

`id` 是上传会话 ID，不是最终文件 ID。后续请求只需会话密钥；按返回的 `partSize` 分片，索引从 0 开始，只有末片可以更短。`expiresAt` 是 Unix 毫秒时间戳，过期会话不能继续使用。

以下顺序上传示例适用于 Bash、jq 和 GNU split，沿用前面的变量与 `photo.jpg`：

```sh
set -euo pipefail
PICLOOM_PARTS_DIR=$(mktemp -d)
trap 'rm -rf "$PICLOOM_PARTS_DIR"' EXIT

jq -n --arg profile "$PICLOOM_PROFILE_ID" \
  --argjson size "$(wc -c < photo.jpg)" \
  '{profileId: $profile, size: $size, name: "photo.jpg"}' |
  curl --fail-with-body "$PICLOOM_URL/api/uploads" \
    -H "Authorization: Bearer $PICLOOM_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @- \
    > "$PICLOOM_PARTS_DIR/session.json"

PICLOOM_SESSION_ID=$(jq -r '.id' "$PICLOOM_PARTS_DIR/session.json")
PICLOOM_UPLOAD_KEY=$(jq -r '.uploadKey' "$PICLOOM_PARTS_DIR/session.json")
PICLOOM_PART_SIZE=$(jq -r '.partSize' "$PICLOOM_PARTS_DIR/session.json")
split -b "$PICLOOM_PART_SIZE" -d -a 6 photo.jpg "$PICLOOM_PARTS_DIR/part-"
PICLOOM_PART_INDEX=0
for part in "$PICLOOM_PARTS_DIR"/part-*; do
  curl --fail-with-body \
    "$PICLOOM_URL/api/uploads/$PICLOOM_SESSION_ID/parts/$PICLOOM_PART_INDEX" \
    -X PUT -H "X-Upload-Key: $PICLOOM_UPLOAD_KEY" --data-binary "@$part"
  PICLOOM_PART_INDEX=$((PICLOOM_PART_INDEX + 1))
done
curl --fail-with-body \
  "$PICLOOM_URL/api/uploads/$PICLOOM_SESSION_ID/complete" \
  -X POST -H "X-Upload-Key: $PICLOOM_UPLOAD_KEY"
```

需要续传时查询进度，只补传 `parts` 中缺失的索引；客户端可按 `/api/client-settings` 返回的分片并发值并行上传。示例未实现自动续传；中断后放弃会话可调用取消接口，否则等待过期清理。会话密钥不要写入公开链接或日志。

## 登录与管理

以下示例需要 jq。按提示输入用户名和密码；Cookie 和会话文件应保存在私有临时目录，用完删除。

```sh
set -euo pipefail
umask 077
PICLOOM_AUTH_DIR=$(mktemp -d)
trap 'rm -rf "$PICLOOM_AUTH_DIR"' EXIT
read -r -p 'Username: ' PICLOOM_USERNAME
read -r -s -p 'Password: ' PICLOOM_PASSWORD
printf '\n'
jq -n --arg username "$PICLOOM_USERNAME" --arg password "$PICLOOM_PASSWORD" \
  '{username: $username, password: $password}' |
  curl --fail-with-body "$PICLOOM_URL/api/auth/login" \
    -H 'Content-Type: application/json' --data-binary @- \
    -c "$PICLOOM_AUTH_DIR/cookies"
unset PICLOOM_PASSWORD

curl --fail-with-body "$PICLOOM_URL/api/auth/session" \
  -b "$PICLOOM_AUTH_DIR/cookies" > "$PICLOOM_AUTH_DIR/session.json"
PICLOOM_CSRF=$(jq -r '.csrfToken' "$PICLOOM_AUTH_DIR/session.json")
curl --fail-with-body "$PICLOOM_URL/api/upload-profiles" \
  -b "$PICLOOM_AUTH_DIR/cookies"
```

上传配置列表返回数组，包含 `id`、`name`、`available`、`maxUploadBytes`、`allowedMimeTypes`；不可用时查看 `reason`。普通用户仅管理自己的图片，管理员可管理全站；插件安装、重载和卸载要求 Owner。

### 文件列表与删除

```sh
curl --fail-with-body "$PICLOOM_URL/api/files?limit=20&offset=0&status=ready" \
  -b "$PICLOOM_AUTH_DIR/cookies"
```

响应体是文件数组，总数在 `X-Total-Count` 响应头中，不是 `{items,total}` 对象。

| 查询参数 | 用途 |
| --- | --- |
| `limit` / `offset` | 默认 50 / 0；`limit` 为 1–100 |
| `status` | 文件状态：`preparing`、`ready`、`blocked`、`failed`、`deleting`、`delete_failed`、`deleted`；另可用 `replica_error` 筛选存在写入或删除失败副本的文件 |
| `mimeType` / `q` | 按图片 MIME 类型，或文件 ID／逻辑路径关键词筛选 |
| `createdFrom` / `createdBefore` | 上传时间范围，Unix 毫秒时间戳，前闭后开 |
| `owner` | 管理员按用户 ID、`me` 或 `guest` 筛选 |
| `source` | 管理员按存储源 ID 筛选 |
| `tag` / `tagMode` | 标签 ID 可重复，例如 `tag=A&tag=B`；匹配 `all`（默认）或 `any` |
| `untagged` / `uncollected` | `true` 筛选未打标签或未加入集合的图片 |
| `collection` | 集合 ID |
| `sort` / `order` | `sort=createdAt`；`order=asc` 或 `desc`（默认） |

分类条件与其他条件取交集，必须处于同一归属；与显式 `owner` 冲突或同时指定标签与 `untagged=true`、集合与 `uncollected=true` 会被拒绝。管理员通过分类筛选自动限定该分类归属。列表返回 `tags`，详情另外返回 `collections` 与内容来源 `origin: { kind: "upload" | "import", userId }`。

删除图片时携带 CSRF，接受请求返回 `202`：

```sh
export PICLOOM_FILE_ID='YOUR_FILE_ID'
curl --fail-with-body "$PICLOOM_URL/api/files/$PICLOOM_FILE_ID" \
  -X DELETE -b "$PICLOOM_AUTH_DIR/cookies" \
  -H "X-CSRF-Token: $PICLOOM_CSRF"
```

删除是异步操作，`202` 不代表远端内容已清理。查询详情可跟踪状态；不支持远端删除的存储行为见对应 [插件说明](./plugins.md)。

### 标签和集合

这些接口只接受登录会话，写请求使用 CSRF。分类列表为数组，`X-Total-Count` 返回总数；查询 `q`、`limit`（默认 50，范围 1–100）、`offset`（默认 0）。管理员可指定 `owner=用户ID`，省略默认为当前用户。令牌不获得列表或分类管理权限。

| 请求 | 输入或结果 |
| --- | --- |
| `GET /api/tags` | 按名称排序的标签列表 |
| `POST /api/tags` | JSON `{ name, ownerId? }`，201 返回定义 |
| `PATCH /api/tags/:id` | JSON `{ name }`，200 返回定义 |
| `DELETE /api/tags/:id` | 删除定义及关联，200 返回 `{ "ok": true }` |
| `GET /api/collections` | 集合列表；可选 `sort=name\|createdAt`、`order=asc\|desc`，默认名称升序 |
| `GET /api/collections/:id` | 集合详情 |
| `POST /api/collections` | JSON `{ name, description?, ownerId? }`，201 返回集合 |
| `PATCH /api/collections/:id` | JSON `{ name?, description? }`，200 返回集合；空描述清空 |
| `DELETE /api/collections/:id` | 删除定义及关联，保留图片 |
| `POST /api/files/batch-tags` | JSON `{ ids, add?, remove? }` |
| `POST /api/files/batch-collections` | JSON `{ ids, add?, remove? }` |

创建时 `ownerId` 省略为当前用户，管理员可显式传其他用户 ID，不能传 `null`；修改不能变更归属。名称去首尾空白、NFC 规范化、禁止控制字符，标签 1–64、集合 1–100 个 Unicode 码点，描述最多 2000 个。范围内名称不区分大小写唯一，重名返回 409。

标签定义返回 `id`、`ownerId`、`name`、`createdAt`、`updatedAt`；集合另外返回 `description`、`readyFileCount` 和 `preview`。预览为最新可用图片的 `{ fileId, thumbnailUrl }`，无可用图片时为 `null`，缩略图需要会话认证。

批量接口也用于单图。`ids` 为 1–100 个不同图片 ID，`add`、`remove` 为分类 ID 数组，不能重叠且至少有一项操作。每张图片最多 100 个标签和 100 个集合，按移除后添加的最终结果校验。响应为 `{ "results": [{ "id": "…", "accepted": true }, { "id": "…", "accepted": false, "error": "错误码" }] }`。分类无效整体拒绝，图片不存在、权限或归属不符逐项失败。访客图片不能添加分类，管理员也不例外。其他关联保留，删除中或已删除图片只能移除关联。

### 删除与解除关联的范围

`POST /api/files/batch-delete` 接收 `ids`（1–100 个不同文件 ID），可选管理员参数 `sourceId`、`includeLast`（默认 `true`）。未指定 `sourceId` 时删除整张图片，普通成员只能删除自己的图片。响应为 `{"results":[{"id":"…","accepted":true},{"id":"…","accepted":false,"error":"BUSY"}]}`，逐项返回结果。

管理员解除关联使用以下接口，JSON 必须包含 `"confirm":true`，返回 `{"ok":true}`；批量接口返回上述逐项结果：

| 请求 | JSON 参数 |
| --- | --- |
| `POST /api/files/:id/detach` | `confirm` |
| `POST /api/files/:id/replicas/:replicaId/detach` | `confirm`，可选 `includeLast`（默认 `true`） |
| `POST /api/files/batch-detach` | `confirm`、`ids`（1–100 个不同 ID），可选 `sourceId`、`includeLast`（默认 `true`） |

解除关联不调用存储插件，不删除存储文件；会结束管理、取消关联的非运行任务、释放容量，保留记录与历史。按源或副本处理时，有其他 `ready` 副本就只处理目标；否则 `includeLast:true` 处理整张图片及其他失败副本，`false` 返回 `LAST_REPLICA`。上传、写入或相关任务运行期间返回 `BUSY`（409），可稍后重试。删除使用异步任务，成功接收不等于远端删除成功。

### 存储源清理任务

以下接口要求管理员会话：

| 请求 | 参数与结果 |
| --- | --- |
| `GET /api/storage-sources/:id/cleanup-preview` | 返回 `total`、`withoutOtherReady` 与阻挡提交的存储组 `groups` |
| `POST /api/storage-sources/:id/cleanups` | JSON 可选 `mode:"delete"` 或 `"detach"`、`includeLast:true`，均为默认值；202 返回任务 |
| `GET /api/storage-sources/:id/cleanups/latest` | 返回最新任务，无任务时为 `null` |
| `GET /api/storage-sources/:id/cleanups/:jobId` | `limit` 默认 25、范围 1–100，`offset` 默认 0；返回 `job`、`counts`、分页 `items`、当前 `remaining` 引用数与 `groups` |
| `POST /api/storage-sources/:id/cleanups/:jobId/retry` | 202；只重试原任务的失败项 |

提交要求此源不再被存储组引用，否则返回 `SOURCE_IN_USE`（409）。每源同时只有一个活动任务，重复提交返回现有任务。提交事务固定当前未终结副本，不扫描未登记对象；后续新增引用和配置变化不影响固定范围。任务持久化并在重启后继续，状态为 `active` 或 `finished`；项目状态为 `pending`、`running`、`success`、`kept`、`failed`。只有管理结束才计为成功，整图操作需等待所有副本结束；保留条件在逐项开始时检查。删除重试复用原删除任务，不创建新的自动重试预算。

任务结束不代表此源当前无引用。删除源配置仍需满足原配置引用、副本和运行调用条件，并单独调用 `DELETE /api/storage-sources/:id`。切换操作方式需在当前任务结束后提交新任务；其他清理活动期间重试旧任务返回 409。

### 其他管理入口

| 请求 | 用途 |
| --- | --- |
| `GET /api/files/:id` | 文件详情 |
| `POST /api/files/:id/replace` | 用已上传的新图替换，保留公开链接；仅会话认证 |
| `GET /api/files/:id/operations` | 管理员查看副本和后台任务 |
| `DELETE /api/files/:id/replicas/:replicaId` | 管理员删除副本；`?includeLast=false` 保留没有其他可用副本的图片，默认 `true` |
| `POST /api/files/:id/unblock` | 管理员解除屏蔽 |
| `POST /api/files/:id/replicas/:replicaId/terminate` | 管理员将删除失败的副本人工标记为已删除，JSON：`{"confirm":true}`，返回 `{"ok":true}` |
| `POST /api/tasks/:id/retry` | 管理员重试符合条件的失败任务 |
| `GET /api/settings`、`PUT /api/settings` | 读取、保存全套运行设置 |
| `GET /api/system/status` | 管理员查看系统运行状态 |
| `POST /api/storage-sources/:id/import` | 管理员分页导入，JSON：`publicPrefix`、`mimeTypes`，可选 `scope`、`cursor`、`stripDirectories`（默认 `0`，非负整数）、`organization`（与上传相同，只用于新记录；限定执行导入者范围，每页沿用选择） |
| `/api/storage-sources`、`/api/storage-groups` | 管理存储源和存储组 |
| `/api/upload-profiles`、`/api/pipelines` | 管理上传配置与流水线 |

存储组的 `replicaCount` 表示总副本数，范围为 `1` 到成员数量。副本详情按存储源和状态展示。

人工标记要求副本为 `delete_failed` 且无关联运行任务，已为 `deleted` 时重复请求成功。此操作保留历史并结束管理，不保证远端删除；标记后的失败任务不可重试。副本响应的 `instanceDeleted` 表示存储源配置已删除，`instanceId` 保留原标识；配置不存在时 `name` 回退为该标识。存储源的 `usedStorageBytes` 按全部未终结副本统计，`replicaCount` 表示未终结副本数量。

配置修改使用接口要求的 `expectedVersion` 防止覆盖并发更新；遇到 `CONFLICT` 先重新读取。`PUT /api/settings` 接收完整设置对象，不是局部补丁，可先 GET 后修改对应字段再提交。

管理配置的请求字段见 [`shared/config.ts`](https://github.com/llleixx/picloom/blob/main/shared/config.ts)，响应类型见 [`shared/api.ts`](https://github.com/llleixx/picloom/blob/main/shared/api.ts)。

### 插件配置与敏感值

存储源、上传配置中的路径插件和流水线步骤都提交完整的普通 `config`，服务端不补 Schema 默认值；未提交的普通字段保持缺失，并按 Schema 校验。新建接口也须提供全部必需字段。声明了本地目录的路径字段会在保存时解析为绝对路径。

敏感字段使用 `secretEdits`，键为 JSON Pointer，例如 `/token` 或 `/credentials/token`。每项为 `{ "action": "preserve" }`、`{ "action": "replace", "value": "..." }` 或 `{ "action": "clear" }`。省略编辑与 `preserve` 等价；新实例没有旧值可保留。`replace` 的值必须符合字段类型，空字符串与 `clear` 不同。直接在 `config` 中填写敏感字段不会更新它。响应中的 `secretPresence` 仅表示是否已设置，不包含凭据。

读取后修改普通配置时保留其他普通字段；清除凭据必须显式提交 `clear`。完整规则及三类 Schema 的能力范围见[配置与请求参数](../development/schema.md#三类-schema-的边界)。主题配置公开且不支持敏感字段，其草稿、预览和应用规则见[主题开发](../development/themes.md)。

## 错误响应

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Expected JSON object",
    "requestId": "REQUEST_ID"
  }
}
```

字段错误可能附带 `fields`，每项包含 `path` 和 `message`。根据 `code` 判断行为，用 `requestId` 关联日志，不依赖显示文案。

| HTTP 状态 | 常见含义与处理 |
| --- | --- |
| `400` | 字段或参数无效，修正请求 |
| `401` / `403` | 未登录、凭证失效、权限不足、CSRF 或 Origin 不匹配 |
| `404` / `410` | 资源不可访问，或上传会话已过期 |
| `409` | 并发冲突或状态不允许，重新读取后判断 |
| `413` | 文件或请求过大，检查各层上限；大文件改用分片 |
| `429` / `503` | 额度、并发或容量限制，按错误码确认原因；达到每日额度不能靠立即重试解决 |

网络中断不等于写入未发生，勿无条件重放上传。插件相关错误语义见 [错误、取消与并发](../development/plugin-errors.md)。

### 默认上传配置

普通上传、URL 上传和分片会话创建均允许省略 `profileId`。服务端优先使用用户设置的默认项；仅未设置时使用站点默认。默认项被删除、禁用或超出当前用户或 Token 权限时直接报错，不再回退。未配置任何默认项时返回 `DEFAULT_PROFILE_REQUIRED`。显式传入无效 ID 不会回退，上传执行失败也不会切换 Profile。分片会话固定创建时解析出的 Profile。

- `GET /api/upload-defaults`：返回 `defaultProfileId`、`userDefaultProfileId`、当前身份可见的 `siteDefaultProfileId`。
- `PUT /api/auth/upload-default`：会话用户设置自己的默认项，JSON `{ "profileId": "..." }`；传 `null` 表示跟随站点。
- `PUT /api/site-upload-default`：管理员会话设置站点默认项，同上；传 `null` 清除。

这些默认项不会扩大权限，也不会在文件大小超限、存储故障时替用户选择另一套上传规则。

### 替换图片

先按正常流程上传新图，再向 `POST /api/files/:id/replace` 发送 JSON：`{"replacementId":"新文件 ID","replacementPath":"新上传结果 URL 的 pathname"}`。上传时显式选择原上传配置或其他有权限的配置，不依赖默认配置回退。

新旧图片必须可管理、处于 ready 状态、最终格式一致，且副本及后台任务已成功完成。成功返回新文件的 `id` 和保留的 `url`，旧文件随后异步清理；图片归属保持不变。切换失败不会删除原图，新上传的图片可能作为独立图片保留。公开链接不变，浏览器和 CDN 已有缓存需等到过期或主动刷新。

## 主题管理

`GET /api/theme` 返回启用主题描述或 `null`，匿名可读。其余主题管理接口限所有者，写请求使用会话 CSRF：

| 方法与路径                             | 内容                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/themes`                      | 已安装主题、兼容状态和候选配置                                                               |
| `POST /api/themes/inspect`             | 请求体为原始 ZIP 字节，返回 `ticket` 和 `manifest`，凭据有效期 15 分钟                       |
| `POST /api/themes/install`             | `{ "ticket": "…", "confirmed": true }`                                                       |
| `PUT /api/themes/:id/:version/config`  | `{ config, language: { defaultLocale, languageRevision } }`                                  |
| `GET /api/themes/:id/:version/preview` | 读取该版本候选配置及资源入口                                                                 |
| `PUT /api/theme`                       | `{ id, version, defaultLocale, languageRevision }` 启用已保存草稿；`{ "id": null }` 恢复默认 |
| `DELETE /api/themes/:id/:version`      | 卸载非启用版本                                                                               |

资源位于 `/assets/themes/:id/:version/...`，可公开获取并长期缓存。不要将未发布的敏感文件放入主题包。后台使用的配置、预览权限不等于包内资源访问隔离。
