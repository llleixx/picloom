# HTTP API

此页覆盖上传接入与常用管理入口。当前为开发版本，管理请求字段以 [`shared/config.ts`](https://github.com/llleixx/picloom/blob/main/shared/config.ts) 和 [`src/http/app.ts`](https://github.com/llleixx/picloom/blob/main/src/http/app.ts) 为准。

## 上传令牌方式

先在 [上传令牌](../guide/access.md#上传令牌) 页面创建令牌。以下命令使用 Bash，需要将地址和令牌替换为自己的值。

```sh
export PICLOOM_URL='https://pic.example.com'
export PICLOOM_TOKEN='替换为上传令牌'
curl --fail-with-body "$PICLOOM_URL/api/upload-profiles" \
  -H "Authorization: Bearer $PICLOOM_TOKEN"
```

接口返回该身份可见的上传配置数组。选择 `available: true` 的配置，记录其 `id`；`name` 是显示名称，不能代替 ID。`maxUploadBytes` 和 `allowedMimeTypes` 分别表示大小与格式限制，不可用时可查看 `reason`。

### 上传本地图片

`POST /api/files` 使用 `multipart/form-data`，每个请求上传一张图片：

| 字段 | 必填 | 内容 |
| --- | --- | --- |
| `profileId` | 是 | 上传配置 ID |
| `file` | 是 | 图片文件 |
| `params` | 否 | JSON 字符串，如 `{"w":1600}`；相应参数需在上传流水线中启用 |

```sh
export PICLOOM_PROFILE_ID='替换为上传配置ID'
curl --fail-with-body "$PICLOOM_URL/api/files" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -F "profileId=$PICLOOM_PROFILE_ID" \
  -F 'file=@photo.jpg'
```

让 curl 自动设置 multipart 的 Content-Type 和 boundary。成功返回 HTTP `201`，响应示例：

```json
{
  "id": "示例文件ID",
  "url": "https://img.example.com/i/9b7c6d5e4f304162a8b9c0d1e2f34567.jpg"
}
```

使用 `url` 分享图片；`id` 用于在管理接口中定位文件。返回成功时主副本已写入，冗余与保存后处理可能仍在执行。

普通上传的内容上限为 20 MiB，同时受全局、用户与上传配置等限制。提高全局上限不会取消普通上传的上限，大文件应使用分片接口。

### 从 URL 上传

`POST /api/files/from-url` 接收 JSON，成功同样返回 `201` 和文件 `id`、`url`：

```sh
curl --fail-with-body "$PICLOOM_URL/api/files/from-url" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"替换为上传配置ID","url":"https://example.com/photo.jpg"}'
```

远端地址必须能被服务器直接读取，并通过地址与大小校验。此接口当前不接收自定义上传处理参数，使用上传流水线保存的固定配置。

## 分片上传

| 步骤 | 请求 | 内容 |
| --- | --- | --- |
| 创建 | `POST /api/uploads` | JSON：`profileId`、`size`，可选 `name`、`params` |
| 写分片 | `PUT /api/uploads/:id/parts/:index` | 请求体为原始字节，索引从 0 开始 |
| 查进度 | `GET /api/uploads/:id` | 获取已接收的分片 |
| 完成 | `POST /api/uploads/:id/complete` | 分片齐全后提交，进入图片处理与存储流程 |
| 取消 | `DELETE /api/uploads/:id` | 取消会话并清理暂存 |

创建请求需携带上传令牌。`size` 是整个文件的字节数，`params` 是 JSON 对象。成功返回 HTTP `201`，包含：

| 字段 | 含义 |
| --- | --- |
| `id` | 上传会话 ID，不是最终文件 ID |
| `uploadKey` | 后续请求使用的会话密钥 |
| `partSize` | 每片字节数，末片可以更短 |
| `expiresAt` | 会话过期时间，Unix 毫秒时间戳 |

后续请求用 `X-Upload-Key: <uploadKey>` 访问该会话。按返回的 `partSize` 切分文件并上传全部分片，再调用完成接口；完成接口返回 HTTP `200` 和文件 `id`、`url`。

进度响应的 `parts` 是已接收分片的索引数组，例如 `[0, 1, 3]`。续传前查询进度，补传缺失分片。上传会话过期后不能继续使用；放弃上传时调用取消接口。`uploadKey` 持有者可操作该会话，不应将它写入公开链接或日志。

## 管理会话

浏览器使用 `POST /api/auth/login` 登录，字段为 `username`、`password`，保存响应 Cookie。`GET /api/auth/session` 返回会话及 `csrfToken`；修改请求携带 `X-CSRF-Token`，Origin 若存在必须与站点来源匹配。

上传令牌不能替代管理会话。

| 资源           | 常用接口                                      |
| -------------- | --------------------------------------------- |
| 文件列表、上传 | `GET /api/files`、`POST /api/files`           |
| 文件详情、删除 | `GET /api/files/:id`、`DELETE /api/files/:id` |
| 副本与任务详情 | `GET /api/files/:id/operations`               |
| 放弃清理并移除记录 | `POST /api/files/:id/forget`，JSON：`{"confirm":true}`；仅管理员、仅删除中的图片，远端文件可能保留 |
| 删除任务重试   | `POST /api/tasks/:id/retry`                   |
| 存储源         | `/api/storage-sources`                        |
| 存储组         | `/api/storage-groups`                         |
| 上传配置       | `/api/upload-profiles`                        |
| 流水线         | `/api/pipelines`                              |
| 运行设置       | `GET /api/settings`、`PUT /api/settings`      |
| 系统状态       | `GET /api/system/status`                      |

列表接口的过滤与分页参数因资源不同而不同。配置修改带版本约束；收到 `CONFLICT` 后重新读取，不要直接覆盖新配置。

## 错误响应

```json
{ "error": { "code": "INVALID_INPUT", "message": "…", "requestId": "…" } }
```

字段校验可能附带 `fields`。用 `code` 判断行为，用 `requestId` 对照日志；不要依赖显示文案。插件错误码见 [插件错误协议](../development/plugin-errors.md)。
