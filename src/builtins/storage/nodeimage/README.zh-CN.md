# NodeImage 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/nodeimage/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/nodeimage/README.zh-CN.md)

## 用途

使用 NodeImage API 托管图片。

`builtin.nodeimage` · `storage`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `apiKey` | API 密钥 | 是 | — | 敏感 |
| `redirect` | 普通读取允许 302 跳转 | 否 | `true` | — |
| `timeoutMs` | 请求超时，毫秒 | 否 | `30000` | ≥ 100；≤ 120000 |

无请求参数。

## 使用示例

填写 NodeImage API 密钥，将存储源加入存储组并关联上传配置。上传后检查公开链接；删除时按下述平台限制处理。

```json
{
  "apiKey": "YOUR_API_KEY"
}
```

## 行为与限制

使用固定服务 `https://api.nodeimage.com`。上传在内存中收集内容后提交 multipart 表单，远端对象由返回的图片 ID 定位，不按 Picloom 路径建立目录。默认允许跳转读取，也支持内容流。不提供枚举。缺少上传结果时无法可靠恢复；有定位信息时检查远端信息与大小。删除接口返回 404、405 或 501 时，按平台不支持删除处理，Picloom 完成本地清理，不报错或重试；远端图片可能仍存在，需在 NodeImage 手动删除。其他认证、网络或服务异常仍报错。
