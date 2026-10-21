# 配置与请求参数

`configSchema` 声明管理员填写的固定配置；`paramsSchema` 声明上传或访问时传入的参数。Picloom 根据声明生成表单并校验输入。

<span id="配置描述字段"></span>

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

<span id="createinstance-创建运行对象"></span>

## 读取配置

在 `createInstance({ config, services })` 中读取已校验配置，再通过闭包供运行方法使用。例如缩放插件在 `process` 中使用 `Number(config.width)`；[完整实现](./processors/upload.md#最小实现)展示了读取图片、缩放和返回输出的过程。

Picloom 在准备或重新加载实例时调用 `createInstance`，返回的对象会复用，也可能同时处理多个请求。可在这里创建客户端；每张图片的操作放在运行方法中。初始化失败时抛错。

输入中的 `id` 是配置实例 ID，`services` 提供[宿主服务](./plugin-services.md)。普通 `config` 不包含敏感值，凭据通过 `services.readSecrets()` 读取。

<span id="界面提示与翻译"></span>

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
PICLOOM_URL=http://localhost:3000
PICLOOM_TOKEN=替换为上传令牌
PICLOOM_PROFILE=替换为上传配置ID
curl --fail-with-body "$PICLOOM_URL/api/files" \
  -H "Authorization: Bearer $PICLOOM_TOKEN" \
  -F "profileId=$PICLOOM_PROFILE" \
  -F 'file=@image.png' \
  -F 'params={"width":800}'
```

访问参数来自 URL 查询字符串，例如 `?width=800`。参数仅支持一层可选字符串、数值和布尔值；保存后阶段没有请求参数。详细限制见 [Schema 参考](./schema.md#请求参数)。

<span id="validateconfig-补充校验"></span>

## 补充校验

Schema 无法表达的业务规则可由 `validateConfig` 检查。下面假设已声明 `minWidth` 和 `maxWidth` 两个必填整数：

```ts
async validateConfig(config) {
  return Number(config.minWidth) > Number(config.maxWidth)
    ? [{ path: "/maxWidth", message: "Maximum must be at least minimum" }]
    : [];
},
```

返回空数组表示通过；错误的 `path` 使用 JSON Pointer，省略表示整体配置。宿主保存时在结构校验和本地目录解析后调用此方法。

输入可能包含敏感值，不要将它写入错误或日志。错误文案对外可能被替换为通用提示。此方法只校验数据，不修改输入或执行远端写入。

## 进一步阅读

<span id="值应该放在哪里"></span><span id="密钥与运行状态"></span><span id="宿主服务接口"></span><span id="调用上下文"></span><span id="文件与输出"></span>
密钥、状态、上下文和文件操作已移至[宿主服务与运行上下文](./plugin-services.md)。

<span id="配置表单与校验"></span><span id="三类-schema-的边界"></span><span id="默认值与保存"></span><span id="敏感字段与不可变字段"></span>
完整类型、默认值和字段约束见 [Schema 参考](./schema.md)。配置升级见 [migrateConfig](./plugin-release.md#migrateconfig-转换旧配置)。

<span id="宿主实现边界"></span>
核心贡献者可查阅[包配置与文案的实现](./architecture.md#包配置与文案)。
