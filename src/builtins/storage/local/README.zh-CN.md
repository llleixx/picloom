# 本地存储

[English](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.md) | [简体中文](https://github.com/llleixx/picloom/blob/main/src/builtins/storage/local/README.zh-CN.md)

## 用途

将图片保存在应用可访问的本地目录。

`builtin.local` · `storage`

## 配置

下表默认值仅用于生成初始草稿，保存时不补值；“必填”表示提交时必须存在，清空后须重新填写。创建后不可修改的字段标为“固定”。

| 字段 | 含义 | 必填 | 默认值 | 约束 |
| --- | --- | --- | --- | --- |
| `root` | 根目录 | 是 | — | 固定 |

无请求参数。

## 使用示例

创建存储源，加入存储组，再将存储组关联到上传配置。上传图片后，确认根目录中出现文件，公开链接可以访问。Docker 中应挂载该目录以持久化图片。

```json
{
  "root": "./images"
}
```

## 行为与限制

支持流式读写、删除、文件枚举和写入恢复。相对目录以应用工作目录为基准；目录需可读写，实例创建后根目录不可修改。`.picloom/` 保存操作记录，用于确认写入归属；不要当成无用缓存删除。枚举跳过符号链接、内部目录和 `.part` 文件。

导入默认保留完整存储路径作为公开路径；「公开路径去除层数」可去除开头目录，例如 `ab/cd/photo.jpg` 去除两层后使用 `photo.jpg`。扫描范围不影响计算起点，实际存储路径不变。路径不足计为失败，公开路径冲突不覆盖，已登记的存储对象跳过。
