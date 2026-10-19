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
| `profileId` | 是 | 上传配置 ID，不能使用显示名称代替 |
| `file` | 是 | 图片文件 |
| `params` | 否 | JSON 字符串，例如 `{"w":1600}`；对应参数必须已在上传流水线步骤中开放 |

需要参数时在命令中增加 `-F 'params={"w":1600}'`。让 curl 自动设置 multipart 的 Content-Type 和 boundary。

成功返回 HTTP `201`：

```json
{
  "id": "c95011dd-dba9-416d-a7b4-2812b2f7e87c",
  "url": "https://img.example.com/i/9b7c6d5e4f304162a8b9c0d1e2f34567.jpg"
}
```

`url` 用于分享，`id` 用于管理。主副本此时已写入，后台冗余与保存后处理可能仍在执行。

普通上传文件上限为 20 MiB，并同时受全局、用户和上传配置限制。提高全局上限不会解除普通上传上限，大文件需使用分片接口。

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
| 创建 | `POST /api/uploads` | JSON：`profileId`、`size`，可选 `name`、`params`；返回 `201` |
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
| `status` | `preparing`、`ready`、`blocked`、`failed`、`deleting`、`deleted` |
| `mimeType` / `q` | 按图片 MIME 类型，或文件 ID／逻辑路径关键词筛选 |
| `createdFrom` / `createdBefore` | 上传时间范围，Unix 毫秒时间戳，前闭后开 |
| `owner` | 管理员按用户 ID、`me` 或 `guest` 筛选 |
| `source` | 管理员按存储源 ID 筛选 |

删除图片时携带 CSRF，接受请求返回 `202`：

```sh
export PICLOOM_FILE_ID='YOUR_FILE_ID'
curl --fail-with-body "$PICLOOM_URL/api/files/$PICLOOM_FILE_ID" \
  -X DELETE -b "$PICLOOM_AUTH_DIR/cookies" \
  -H "X-CSRF-Token: $PICLOOM_CSRF"
```

删除是异步操作，`202` 不代表远端内容已清理。查询详情可跟踪状态；不支持远端删除的存储行为见对应 [插件说明](./plugins.md)。

### 其他管理入口

| 请求 | 用途 |
| --- | --- |
| `GET /api/files/:id` | 文件详情 |
| `GET /api/files/:id/operations` | 管理员查看副本和后台任务 |
| `DELETE /api/files/:id/replicas/:replicaId` | 管理员删除单个副本 |
| `POST /api/files/:id/unblock` | 管理员解除屏蔽 |
| `POST /api/files/:id/forget` | 管理员放弃清理并移除删除中的记录，JSON：`{"confirm":true}` |
| `POST /api/tasks/:id/retry` | 管理员重试失败的删除任务 |
| `GET /api/settings`、`PUT /api/settings` | 读取、保存全套运行设置 |
| `GET /api/system/status` | 管理员查看系统运行状态 |
| `/api/storage-sources`、`/api/storage-groups` | 管理存储源和存储组 |
| `/api/upload-profiles`、`/api/pipelines` | 管理上传配置与流水线 |

配置修改使用接口要求的 `expectedVersion` 防止覆盖并发更新；遇到 `CONFLICT` 先重新读取。`PUT /api/settings` 接收完整设置对象，不是局部补丁，可先 GET 后修改对应字段再提交。

管理配置的请求字段见 [`shared/config.ts`](https://github.com/llleixx/picloom/blob/main/shared/config.ts)，响应类型见 [`shared/api.ts`](https://github.com/llleixx/picloom/blob/main/shared/api.ts)。

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
