# 图片处理

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/sharp/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/processor/sharp/README.zh-CN.md)

## 用途

在上传或访问阶段调整尺寸、格式和质量。

`builtin.sharp` · `processor` · `upload`, `access`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。

上传实例可设置下表全部字段；访问实例配置使用 `{}`。两个阶段的请求参数均为 `w`、`h`、`fit`、`q`、`format`，需在流水线步骤中显式开放，约束与表中相同。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `w` | 目标宽度，像素 | 否 | — | ≥ 1 |
| `h` | 目标高度，像素 | 否 | — | ≥ 1 |
| `fit` | 尺寸适配方式 | 否 | — | `inside`, `cover`, `contain`, `fill` |
| `q` | 输出质量 | 否 | — | ≥ 1；≤ 100 |
| `format` | 输出格式 | 否 | — | `jpeg`, `png`, `webp` |

## 使用示例

上传阶段：使用下列固定配置，将实例加入上传流水线并关联上传配置，上传 JPEG 后得到宽度不超过 1280 的 WebP。访问阶段：实例配置使用 `{}`，加入全局访问流水线并开放 `w` 参数，在图片链接后追加 `?w=320` 查看派生结果。

```json
{
  "w": 1280,
  "format": "webp",
  "q": 80
}
```

## 行为与限制

仅处理静态 JPEG、PNG、WebP；透明图片转 JPEG 返回不支持。上传阶段请求参数覆盖同名固定配置；访问阶段只通过请求参数指定变换。没有变换参数时跳过，成功时返回 `replace`。`fit` 需要至少一个尺寸，省略时使用 `inside`；省略输出格式则保留输入格式。JPEG/WebP 未指定质量时使用 80；PNG 指定质量时启用调色板编码。

### 尺寸适配示例

以 1600 × 900 原图和 `w=640&h=480` 为例：

| `fit` | 行为 | 否 |
| --- | --- | --- |
| `inside` | 等比缩小，不裁剪 | 640 × 360 |
| `cover` | 等比填满，裁去左右超出部分 | 640 × 480 |
| `contain` | 等比缩小，上下留边 | 640 × 480 |
| `fill` | 拉伸到指定尺寸 | 640 × 480，比例改变 |

只需等比缩小可只传 `w` 或 `h`。`q` 表示编码质量，不是输出大小百分比。访问示例：`<图片URL>?w=640&h=480&fit=cover&format=webp`。
