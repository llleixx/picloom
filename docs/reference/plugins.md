# 官方插件

选择插件查看配置、示例与能力限制。内置插件随主程序提供；官方外部插件按需安装，可在移除引用后卸载。

外部插件的下载、安装、配置接入及版本更新见[安装与使用插件](../guide/plugins.md)。

## 路径插件

| 插件 | ID |
| --- | --- |
| [日期路径](./plugins/date-path.md) | `builtin.date-path` |
| [随机路径](./plugins/random-path.md) | `builtin.random-path` |

## 存储插件

| 插件 | ID |
| --- | --- |
| [本地存储](./plugins/local.md) | `builtin.local` |
| [S3 兼容存储](./plugins/s3.md) | `builtin.s3` |
| [WebDAV 存储](./plugins/webdav.md) | `builtin.webdav` |

## 处理插件

| 插件 | ID |
| --- | --- |
| [图片变换](./plugins/sharp.md) | `builtin.sharp` |
| [水印](./plugins/watermark.md) | `builtin.watermark` |
| [Telegram 通知](./plugins/telegram-notification.md) | `builtin.telegram-notification` |

存储插件的枚举、删除和写入恢复能力并不相同，选型前请查看对应说明。

## 官方外部插件

由独立的 [picloom-extensions](https://github.com/llleixx/picloom-extensions) 仓库维护，以独立 ZIP 安装，不随主程序提供。

| 插件 | ID |
| --- | --- |
| [OpenList 存储](./plugins/openlist.md) | `picloom.openlist` |
| [NodeImage 存储](./plugins/nodeimage.md) | `picloom.nodeimage` |
| [Telegram 存储](./plugins/telegram.md) | `picloom.telegram-storage` |
| [腾讯云图片审核](./plugins/tencent-moderation.md) | `picloom.tencent-moderation` |
