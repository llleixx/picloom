# 配置与请求参数

`configSchema` 声明管理员填写的固定配置；`paramsSchema` 声明上传或访问时传入的参数。Picloom 根据声明生成表单并校验输入。

## 声明配置

下面的配置要求填写一个正整数宽度，新建表单初始值为 `1280`：

```ts
configSchemaVersion: 1,
configSchema: {
  type: "object",
  properties: {
    width: { type: "integer", minimum: 1, default: 1280 },
  },
  required: ["width"],
},
```

路径和存储插件将这段放在定义顶层；处理插件放在对应的 `stages.upload`、`stages.access` 或 `stages.post_save` 中。没有配置项时可省略 `configSchema`，但仍需声明 `configSchemaVersion`。

`default` 只初始化表单，保存时不会补齐缺失字段。必填字段使用 `required`，完整规则见 [Schema 参考](./schema.md#默认值与保存)。

## 读取配置

宿主准备或重新加载实例时调用 `createInstance`。

```ts
createInstance(input: {
  id: string;
  config: Readonly<Config>;
  services: InstanceServices;
}): Promise<R>;
```

| 输入字段 | 用途 |
| --- | --- |
| `id` | 配置实例 ID |
| `config` | 已校验的普通配置，通过闭包供运行方法使用 |
| `services` | [宿主服务](./plugin-services.md)，敏感配置通过 `readSecrets()` 读取 |

返回对应插件类型的运行对象 `R`。实例可持有客户端，同一实例可能并发处理多个请求。初始化失败时抛错。[上传处理示例](./processors/upload.md#最小实现)在 `process` 中使用实例配置的宽度。

## 添加字段文案

在插件定义顶层的 `messages` 中添加翻译键，各阶段共用同一字典：

```ts
messages: {
  "en-US": { "package.name": "Resize", "width.label": "Maximum width" },
  "zh-CN": { "package.name": "缩放", "width.label": "最大宽度" },
},
```

然后为 `width` 字段增加提示：

```ts
width: {
  type: "integer", minimum: 1, default: 1280,
  "x-ui": { labelKey: "width.label" },
},
```

插件名称通过 `nameKey: "package.name"` 引用，`defaultLocale` 指定默认字典。分组、说明、枚举文案和显示条件见[包文案与表单提示](./package-localization.md)。

## 固定配置与请求参数

上传和访问阶段可在 `configSchema` 旁增加 `paramsSchema`：

```ts
paramsSchema: {
  type: "object",
  properties: {
    width: { type: "integer", minimum: 1, maximum: 8192 },
  },
},
```

管理员还需在流水线步骤中启用 `width`。插件在运行方法中通过 `input.params` 读取，自行决定优先级：

```ts
const width = Number(params.width ?? config.width);
```

此例中，已启用且传入的 `width` 覆盖固定宽度；否则使用固定配置。宿主不会将请求参数合并进 `config`。

安装[上传处理示例](./processors/upload.md#安装与验证)、启用参数后，使用宽于 800 像素的静态 PNG 验证：

```sh
PICLOOM_URL=http://localhost:7425
PICLOOM_TOKEN=替换为上传令牌
PICLOOM_PROFILE=替换为上传配置ID
curl --fail-with-body "$PICLOOM_URL/api/files" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -F "profileId=$PICLOOM_PROFILE" \
  -F 'file=@image.png' \
  -F 'params={"width":800}'
```

访问参数来自 URL 查询字符串，例如 `?width=800`。参数仅支持一层可选字符串、数值和布尔值；保存后阶段没有请求参数。详细限制见 [Schema 参考](./schema.md#请求参数)。

## 补充校验

宿主保存配置时，在结构校验和本地目录解析后调用可选的 `validateConfig`。

```ts
validateConfig(config: Readonly<Config>): Promise<Array<{
  message: string;
  path?: string;
}>>;
```

输入是完整配置，可能含敏感值。返回空数组表示通过，否则为每个错误提供 `message`。可选的 `path` 使用 JSON Pointer，省略时表示整个配置。

以下示例校验两个必填整数字段 `minWidth` 和 `maxWidth`：

```ts
async validateConfig(config) {
  return Number(config.minWidth) > Number(config.maxWidth)
    ? [{ path: "/maxWidth", message: "Maximum must be at least minimum" }]
    : [];
},
```

校验只读取输入。错误和日志中不要包含敏感值。

## 进一步阅读

密钥、状态、上下文和文件操作见[宿主服务与运行上下文](./plugin-services.md)。

完整类型、默认值和字段约束见 [Schema 参考](./schema.md)。配置升级见 [migrateConfig](./plugin-release.md#migrateconfig-转换旧配置)。

核心贡献者可查阅[包配置与文案的实现](./architecture.md#包配置与文案)。
