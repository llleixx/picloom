# 处理插件

处理插件用于改变图片内容，或在保存后给出处理意见。先确定你的需求发生在什么时候：

| 阶段 | 示例需求 | 处理结果影响什么 |
| --- | --- | --- |
| [上传处理](./processors/upload.md) | 保存前缩小图片、添加水印 | 最终存储的图片内容 |
| [访问处理](./processors/access.md) | 用链接参数请求缩略图 | 本次访问结果，原图不变 |
| [保存后处理](./processors/post-save.md) | 审核已保存图片、发送通知 | 文件的公开可用状态或外部操作 |

上传和访问阶段每一步都可以把结果交给下一步。保存后阶段传递处理意见和摘要，不输出替换图片。

## 定义与阶段

三者都声明 `kind: "processor"`。在 `stages` 中声明支持的阶段，每个阶段有自己的配置和 `createInstance`：

```text
插件定义（身份、版本、kind）
└── stages
    ├── upload    → 配置描述 + createInstance → check / process
    ├── access    → 配置描述 + createInstance → check / process
    └── post_save → 配置描述 + createInstance → execute
```

| 定义字段 | 类型 | 必需 | 含义 |
| --- | --- | --- | --- |
| `kind` | `"processor"` | 是 | 插件类型 |
| `stages` | `StageDefinitions` | 是 | 至少包含一个阶段描述 |
| `stages.upload` | `Descriptor<ProcessorPlugin>`，可附 `paramsSchema` | 否 | 上传处理实现 |
| `stages.access` | `Descriptor<AccessPlugin>`，可附 `paramsSchema` | 否 | 访问处理实现 |
| `stages.post_save` | `Descriptor<PostSavePlugin>` | 否 | 保存后处理实现，不支持请求参数 |

其他身份字段见 [插件基础](./plugin-start.md#代码默认导出什么)，各阶段描述的必需和可选字段见 [配置描述字段](./plugin-config.md#配置描述字段)。

只实现需要的阶段即可。教程分别使用三个独立示例，便于单独构建和验证；正式插件也可以同时声明多个阶段。

## 先完成一个阶段

每个教程都会从具体效果讲到完整实现。固定配置、请求参数、密钥等共用能力见 [配置与宿主服务](./plugin-config.md)；异常、取消和实例复用见 [错误、取消与并发](./plugin-errors.md)。
