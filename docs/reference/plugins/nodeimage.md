# NodeImage 存储

使用 NodeImage API 托管图片。

`picloom.nodeimage` · `storage`

## 开始使用

先按[安装插件](../../guide/plugins.md)安装 ZIP。在 **配置 → 存储源** 选择本插件。

填写 NodeImage API 密钥，将存储源加入存储组并关联上传配置。上传后检查公开链接；删除时按下述平台限制处理。

```json
{
  "redirect": true,
  "timeoutMs": 30000,
  "apiKey": "YOUR_API_KEY"
}
```

## 配置

| 字段        | 含义                  | 必填 | 默认值  | 约束            |
| ----------- | --------------------- | ---- | ------- | --------------- |
| `apiKey`    | API 密钥              | 是   | —       | 敏感            |
| `redirect`  | 普通读取允许 302 跳转 | 否   | `true`  | —               |
| `timeoutMs` | 请求超时，毫秒        | 是   | `30000` | ≥ 100；≤ 120000 |

## 行为与限制

使用固定服务 `https://api.nodeimage.com`，默认跳转到远端图片地址；关闭 `redirect` 后由 Picloom 转发内容。不支持导入已有图片。上传中断或超时后可能已经保存，重试会重新写入，可能产生重复对象。

不支持远端删除，执行删除会显示删除失败。可在图片详情中将副本人工标记为已删除，保留历史，**NodeImage 上的图片可能仍然存在**。

[扩展源码](https://github.com/llleixx/picloom-extensions/tree/main/plugins/nodeimage)
