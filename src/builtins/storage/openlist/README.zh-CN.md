# OpenList 存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/openlist/README.zh-CN.md)

## 用途

通过 OpenList API 使用已挂载的存储。

`builtin.openlist` · `storage`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `endpoint` | 服务端点 | 是 | — | 固定 |
| `root` | 根目录 | 是 | — | 固定 |
| `token` | API 令牌 | 是 | — | 敏感 |
| `redirect` | 普通读取允许 302 跳转 | 否 | `true` | — |
| `timeoutMs` | 请求超时，毫秒 | 否 | `30000` | ≥ 100；≤ 120000 |

无请求参数。

## 使用示例

填写 OpenList 服务地址、挂载目录和 API 令牌。将存储源加入上传配置的存储组，上传一张图片，检查挂载目录及返回链接。

```json
{
  "endpoint": "https://openlist.example.com",
  "root": "/Images",
  "token": "YOUR_API_TOKEN"
}
```

## 行为与限制

对象路径由 `root` 与存储路径拼接。支持写入、读取和删除，实际能力取决于上游挂载。默认普通读取跳转到上游下载地址；关闭跳转或要求流时由应用转发，下载请求不携带 API 令牌。不提供枚举；写入恢复返回未知，不能根据对象存在推断属于本次写入。服务地址与挂载目录不可修改。
