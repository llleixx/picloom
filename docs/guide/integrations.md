# 外部集成

## 准备令牌和配置 ID

1. 在 Picloom 的 **上传令牌** 页面[创建令牌](./access.md#上传令牌)，授权目标上传配置。
2. 在 **配置 → 上传配置** 复制配置 ID，也可通过 [API 查询](../reference/http-api.md#上传一张图片)。

以下配置使用 `YOUR_UPLOAD_TOKEN` 和 `YOUR_PROFILE_ID` 表示这两个值。已设置且有权使用[默认上传配置](./profiles.md#设置默认上传配置)时，可省略 `profileId`。

## ShareX

[ShareX](https://getsharex.com/) 是 Windows 上的开源截图工具，可在截图后自动上传到 Picloom 并复制链接。

1. 将以下内容保存为 `Picloom.sxcu`，替换站点地址、令牌和配置 ID。省略 `profileId` 时将 `Arguments` 设为 `{}`。

```json
{
  "Name": "Picloom",
  "DestinationType": "ImageUploader",
  "RequestMethod": "POST",
  "RequestURL": "https://pic.example.com/api/files",
  "Headers": {
    "Authorization": "Bearer YOUR_UPLOAD_TOKEN"
  },
  "Body": "MultipartFormData",
  "Arguments": {
    "profileId": "YOUR_PROFILE_ID"
  },
  "FileFormName": "file",
  "URL": "{json:url}",
  "ErrorMessage": "{json:error.message}"
}
```

2. 双击文件导入 ShareX，在 **目标 → 图片上传器** 中选择 **自定义图片上传器**，在 **自定义上传器设置** 中将图片上传器设为 `Picloom`。
3. 启用 **截图后的任务 → 上传图片到图床** 和 **上传后的任务 → 复制 URL 到剪贴板**。截图后即可粘贴图片链接。

`.sxcu` 文件含有上传令牌，请勿公开分享。其他字段见 [ShareX 自定义上传器文档](https://getsharex.com/docs/custom-uploader)。

## PicGo

1. 在 PicGo 安装 [web-uploader 插件](https://github.com/yuki-xin/picgo-plugin-web-uploader)，选择「自定义Web图床」。
2. 填写下表并设为默认图床。使用默认上传配置时，自定义 Body 可留空。

| 配置项 | 内容 |
| --- | --- |
| API 地址（`url`） | `https://pic.example.com/api/files`，替换为你的站点地址 |
| POST 参数名（`paramName`） | `file` |
| JSON 路径（`jsonPath`） | `url` |
| 自定义请求头（`customHeader`） | `{"Authorization":"Bearer YOUR_UPLOAD_TOKEN"}` |
| 自定义 Body（`customBody`） | `{"profileId":"YOUR_PROFILE_ID"}` |

3. 上传一张测试图片，打开返回的 Picloom 链接。
