# WebDAV 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/webdav/README.zh-CN.md)

## 用途

通过 WebDAV 保存和读取图片。

`builtin.webdav` · `storage`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `endpoint` | 服务端点 | 是 | — | 固定 |
| `keyPrefix` | 对象／目录前缀 | 否 | `""` | 固定 |
| `timeoutMs` | 请求超时，毫秒 | 否 | `30000` | ≥ 100；≤ 120000 |
| `username` | 用户名 | 是 | — | 敏感 |
| `password` | 密码或应用密码 | 是 | — | 敏感 |

无请求参数。

## 使用示例

填写已存在的 WebDAV 根地址和账号凭证，创建存储源并加入存储组。关联上传配置后，上传、访问并删除一张测试图片，确认服务端支持所需方法。

```json
{
  "endpoint": "https://dav.example.com/images/",
  "username": "YOUR_USERNAME",
  "password": "YOUR_APP_PASSWORD"
}
```

## 行为与限制

使用 Basic 认证，通过 PUT、GET、DELETE 操作文件，必要时创建子目录。地址应直接指向最终端点，拒绝重定向。`keyPrefix` 是端点下的相对目录，不要 URL 编码。支持内容流，不提供客户端跳转或枚举。恢复时 HEAD 返回 404 可确认未存储；对象存在不能证明写入归属，返回未知。端点与目录前缀不可修改。
