# 日期路径

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/path/date-path/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/path/date-path/README.zh-CN.md)

## 用途

按 UTC 上传日期与去掉连字符的文件 ID 生成路径。

`builtin.date-path` · `path`

## 配置

无配置项，使用 `{}`。

无请求参数。

## 使用示例

创建路径插件实例，将其选为上传配置的路径插件。以 2026-10-18 上传的 JPEG、文件 ID `12345678-1234-1234-1234-123456789abc` 为例，生成路径为 `2026/10/18/12345678123412341234123456789abc.jpg`；公开前缀 `/i/` 对应链接 `/i/2026/10/18/12345678123412341234123456789abc.jpg`。

```json
{}
```

## 行为与限制

使用处理后图片的 MIME 类型确定扩展名，不使用原文件名。只返回 `logicalKey`，存储路径与公开前缀内的路径相同。日期使用 UTC，可能与本地日期不同。
