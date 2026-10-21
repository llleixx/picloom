# OpenList 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.zh-CN.md)

## 用途

通过 OpenList API 使用已挂载的存储。

`builtin.openlist` · `storage`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `endpoint` | 服务端点 | 是 | — | 固定 |
| `root` | 根目录 | 是 | — | 固定 |
| `token` | API 令牌 | 是 | — | 敏感 |
| `redirect` | 普通读取允许 302 跳转 | 否 | `true` | — |
| `timeoutMs` | 请求超时，毫秒 | 是 | `30000` | ≥ 100；≤ 120000 |

无请求参数。

## 使用示例

填写 OpenList 服务地址、挂载目录和 API 令牌。将存储源加入上传配置的存储组，上传一张图片，检查挂载目录及返回链接。

```json
{
  "redirect": true,
  "timeoutMs": 30000,
  "endpoint": "https://openlist.example.com",
  "root": "/Images",
  "token": "YOUR_API_TOKEN"
}
```

已有图片可在存储源页面选择「导入」。扫描范围是 `root` 内的相对目录，留空扫描整个挂载目录。例如 `root=/Images`、扫描范围为 `2026` 时，`/Images/2026/photo.jpg` 的存储路径为 `2026/photo.jpg`；公开路径去除层数设为 `1` 后，公开路径使用 `photo.jpg`，远端文件不移动。

## 行为与限制

对象路径由 `root` 与存储路径拼接。支持写入、读取和删除，实际能力取决于上游挂载。默认普通读取跳转到上游下载地址；关闭跳转或要求流时由应用转发，下载请求不携带 API 令牌。写入恢复返回未知，不能根据对象存在推断属于本次写入。服务地址与挂载目录不可修改。

连接被拒绝时可确认请求未送达，记为写入失败，后台任务可按现有策略重试。传输中断、等待响应超时或响应无效时，写入结果仍可能未知，不自动重试写入。

导入通过目录列表接口分页扫描子目录，不下载图片；令牌须有目录访问权限，不支持额外填写目录密码。扫描使用 OpenList 当前列表（可能有缓存），导入期间应避免增删或移动目录内容；权限或列表异常会报错，不会按空目录跳过。重复导入和路径冲突由 Picloom 统一检查。
