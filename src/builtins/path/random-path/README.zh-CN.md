# 随机路径

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/path/random-path/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/path/random-path/README.zh-CN.md)

## 用途

默认路径插件，从随机文件 ID 稳定生成 32 位文件名。

`builtin.random-path` · `path`

## 配置

下表默认值由核心在保存实例时补齐；“必填”表示没有默认值时必须提供。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `directoryDepth` | 存储目录层数 | 否 | `2` | `0`, `1`, `2` |

无请求参数。

## 使用示例

创建实例并关联上传配置。以文件 ID `12345678-1234-1234-1234-123456789abc` 和 PNG 为例，公开路径为 `12345678123412341234123456789abc.png`，存储路径为 `12/34/12345678123412341234123456789abc.png`。

```json
{
  "directoryDepth": 2
}
```

## 行为与限制

目录层数只影响存储路径，不改变公开链接。相同文件 ID 生成相同路径，不包含日期或原文件名。支持 JPEG、PNG、WebP、SVG、GIF、AVIF、TIFF；上传是否允许该格式还受上传配置限制。
