# WebDAV 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.zh-CN.md)

## 用途

通过 WebDAV 保存和读取图片。

`builtin.webdav` · `storage`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `endpoint` | 服务端点 | 是 | — | 固定 |
| `keyPrefix` | 对象／目录前缀 | 否 | `""` | 固定 |
| `timeoutMs` | 请求超时，毫秒 | 是 | `30000` | ≥ 100；≤ 120000 |
| `username` | 用户名 | 是 | — | 敏感 |
| `password` | 密码或应用密码 | 是 | — | 敏感 |

无请求参数。

## 使用示例

填写已存在的 WebDAV 根地址和账号凭证，创建存储源并加入存储组。关联上传配置后，上传、访问并删除一张测试图片，确认服务端支持所需方法。

```json
{
  "keyPrefix": "",
  "timeoutMs": 30000,
  "endpoint": "https://dav.example.com/images/",
  "username": "YOUR_USERNAME",
  "password": "YOUR_APP_PASSWORD"
}
```

已有图片可在存储源页面选择「导入」。扫描范围相对于 `endpoint` 与 `keyPrefix` 组成的根目录，留空扫描整个根目录。例如端点为 `https://dav.example.com/images/`、目录前缀为 `archive` 时，远端 `archive/2026/photo.jpg` 的存储路径为 `2026/photo.jpg`。公开路径去除层数设为 `1` 后使用 `photo.jpg`，远端文件不移动。

## 行为与限制

使用 Basic 认证，通过 PUT、GET、DELETE 操作文件，必要时创建子目录。地址应直接指向最终端点，拒绝重定向。`keyPrefix` 是端点下的相对目录，不要 URL 编码。支持内容流，不提供客户端跳转。写入中断后对象可能已经保存；重试仍按条件创建，不覆盖已有对象。端点与目录前缀不可修改。

删除使用写入成功或导入时保存的对象定位。缺少已确认的定位时会记录删除失败，可将副本人工标记为已删除以结束管理。

导入要求服务端支持 `PROPFIND`，账号有目录访问权限。逐层扫描，不下载图片，沿用 Picloom 的重复导入和路径冲突检查。WebDAV 没有标准分页，续扫同一目录会重新读取列表；扫描期间避免增删或移动文件。单次目录列表响应上限为 8 MiB，超出会报错，可缩小扫描范围；若单个目录本身过大，需要先拆分目录。目录读取失败或返回非法路径会报错，不会当作空目录跳过。
