# 外部集成

## ShareX

[ShareX](https://getsharex.com/) 是 Windows 上的开源截图工具，可在截图后自动上传到 Picloom 并复制链接。

1. 在 Picloom 的 **上传令牌** 页面[创建令牌](./access.md#上传令牌)，允许使用目标上传配置。
2. 在 **配置 → 上传配置** 中复制配置 ID，也可通过 [API 查询](../reference/http-api.md#上传一张图片)。
3. 将以下内容保存为 `Picloom.sxcu`，替换站点地址、`YOUR_UPLOAD_TOKEN` 和 `YOUR_PROFILE_ID`。

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

4. 双击文件导入 ShareX，在 **目标 → 图片上传器** 中选择 **自定义图片上传器**，在 **自定义上传器设置** 中将图片上传器设为 `Picloom`。
5. 启用 **截图后的任务 → 上传图片到图床** 和 **上传后的任务 → 复制 URL 到剪贴板**。截图后即可粘贴图片链接。

省略 `profileId`（保留 `"Arguments": {}`）时，使用用户或站点默认上传配置。此配置仅上传图片，大小受站点、用户和上传配置限制。

`.sxcu` 文件含有上传令牌，请勿公开分享。其他字段见 [ShareX 自定义上传器文档](https://getsharex.com/docs/custom-uploader)。

## PicGo

在 PicGo 中安装 [web-uploader 插件](https://github.com/yuki-xin/picgo-plugin-web-uploader)，选择“自定义Web图床”，填写以下配置并设为默认图床：

| 配置项 | 内容 |
| --- | --- |
| API 地址（`url`） | `https://pic.example.com/api/files`，替换为你的站点地址 |
| POST 参数名（`paramName`） | `file` |
| JSON 路径（`jsonPath`） | `url` |
| 自定义请求头（`customHeader`） | `{"Authorization":"Bearer YOUR_UPLOAD_TOKEN"}` |
| 自定义 Body（`customBody`） | `{"profileId":"YOUR_PROFILE_ID"}` |

在 Picloom 的 **上传令牌** 页面[创建令牌](./access.md#上传令牌)，授权目标上传配置；在 **配置 → 上传配置** 中复制配置 ID，分别替换表中的占位符。已设置[默认上传配置](./profiles.md)时，自定义 Body 可留空。

通过 PicGo 上传图片后即可获得 Picloom 图片链接。
