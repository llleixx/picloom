# OpenList 存储

通过 OpenList API 使用已挂载的存储。

`picloom.openlist` · `storage`

## 开始使用

先按[安装插件](../../guide/plugins.md)安装 ZIP。在 **配置 → 存储源** 选择本插件。

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

## 配置

默认值用于新配置；标为“固定”的字段创建后不可修改。

| 字段        | 含义                  | 必填 | 默认值  | 约束            |
| ----------- | --------------------- | ---- | ------- | --------------- |
| `endpoint`  | 服务端点              | 是   | —       | 固定            |
| `root`      | 根目录                | 是   | —       | 固定            |
| `token`     | API 令牌              | 是   | —       | 敏感            |
| `redirect`  | 普通读取允许 302 跳转 | 否   | `true`  | —               |
| `timeoutMs` | 请求超时，毫秒        | 是   | `30000` | ≥ 100；≤ 120000 |

## 行为与限制

支持上传、读取、删除和导入，实际能力取决于上游挂载。默认跳转到上游下载地址，关闭 `redirect` 后由 Picloom 转发；下载地址需能在不携带 API 令牌的情况下读取。服务地址和根目录创建后不可修改。

成功上传或导入会保存对象定位。缺少已保存定位时删除失败，不根据存储路径猜测目标；无法完成删除时可在图片详情中将副本人工标记为已删除。

导入需要目录访问权限，不支持额外目录密码。扫描使用 OpenList 的目录列表，可能受缓存影响。写入中断或超时后可能已经保存；允许重试时会重新写入，可能产生重复对象。

[扩展源码](https://github.com/llleixx/picloom-extensions/tree/main/plugins/openlist)
