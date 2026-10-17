<script setup lang="ts">
import { t, locale } from "@/lib/i18n";
import { localizePlugin } from "../../../shared/plugin-localization";
import { computed, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import SchemaField from "./SchemaField.vue";
import { api, errorText } from "@/lib/api";
import {
  cloneJson,
  sensitivePaths,
  type ConfiguredStep,
  type StageView,
  type PipelineKind,
  type PluginSummary,
  type PluginView,
  type Config,
  type UpgradePreview,
} from "../../../shared/config";
const model = defineModel<ConfiguredStep>({ required: true });
const props = defineProps<{
  plugins: PluginSummary[];
  kind: "path" | "storage" | "processor";
  locked?: boolean;
  upgradeOnly?: boolean;
  stage?: PipelineKind;
  label: string;
  errors?: Array<{ path: string; message: string }>;
}>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const rawDefinition = ref<StageView & { name: string }>();
const definition = computed(() =>
  rawDefinition.value
    ? localizePlugin(rawDefinition.value, locale.value)
    : undefined,
);
const error = ref("");
let epoch = 0;
const retry = ref(0),
  loading = ref(false);
const choice = computed({
  get: () =>
    model.value.pluginId
      ? model.value.pluginId + "@" + model.value.version
      : "",
  set: (value: string) => {
    const p = props.plugins.find((p) => p.id + "@" + p.version === value);
    if (p)
      model.value = {
        pluginId: p.id,
        version: p.version,
        config: {},
        ...("onNotApplicable" in model.value
          ? { onNotApplicable: model.value.onNotApplicable }
          : {}),
      };
  },
});
const targetVersion = ref("");
const upgrading = ref(false);
const upgradeFields = ref<Array<{ path: string; message: string }>>([]);
const beforeUpgrade = ref<ConfiguredStep>();
const versions = computed(() => {
  const current = props.plugins.find(
    (p) =>
      p.id === model.value.pluginId &&
      p.version === (model.value.upgrade?.fromVersion ?? model.value.version),
  );
  if (!model.value.key || current?.source !== "external") return [];
  return props.plugins.filter(
    (p) =>
      p.id === current.id &&
      p.kind === props.kind &&
      p.version !== current.version &&
      p.source === "external" &&
      (!props.stage || p.supportedStages?.includes(props.stage)),
  );
});
const removedParams = computed(() =>
  (model.value.enabledParams ?? []).filter(
    (key) =>
      !(key in ((definition.value?.paramsSchema?.properties ?? {}) as Config)),
  ),
);
async function previewUpgrade() {
  if (!model.value.key || !targetVersion.value || upgrading.value) return;
  const draft = model.value;
  upgrading.value = true;
  emit("ready", false);
  error.value = "";
  try {
    const result = await api<UpgradePreview>(
      `/api/plugin-configurations/${encodeURIComponent(model.value.key)}/upgrade-preview`,
      {
        method: "POST",
        body: JSON.stringify({ version: targetVersion.value }),
      },
    );
    if (model.value !== draft) return;
    beforeUpgrade.value = structuredClone(
      JSON.parse(JSON.stringify(model.value)),
    );
    model.value = { ...model.value, ...result.configuration, error: null };
    upgradeFields.value = result.fields;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    upgrading.value = false;
    emit("ready", !!definition.value);
  }
}
watch(
  () => model.value.config,
  (value, old) => {
    if (value === old) upgradeFields.value = [];
  },
  { deep: true },
);
function cancelUpgrade() {
  if (beforeUpgrade.value) model.value = beforeUpgrade.value;
  beforeUpgrade.value = undefined;
  upgradeFields.value = [];
  targetVersion.value = "";
}
function defaults(schema: Config): Config {
  const result: Config = {};
  for (const [key, rule] of Object.entries(
    (schema.properties ?? {}) as Record<string, Config>,
  )) {
    if (rule["x-sensitive"]) continue;
    if (rule.default !== undefined) result[key] = cloneJson(rule.default);
    else if (rule.type === "object") {
      const nested = defaults(rule);
      if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}
watch(
  () => [choice.value, model.value.key, model.value, props.stage, retry.value],
  async () => {
    const current = ++epoch;
    rawDefinition.value = undefined;
    emit("ready", false);
    error.value = "";
    loading.value = false;
    if (!model.value.pluginId) return;
    loading.value = true;
    try {
      const value = await api<PluginView>(
        `/api/plugins/${encodeURIComponent(model.value.pluginId)}/versions/${encodeURIComponent(model.value.version)}`,
      );
      if (current !== epoch) return;
      const description =
        value.kind === "processor"
          ? props.stage
            ? value.stages[props.stage]
            : undefined
          : value;
      if (!description?.configSchema) throw new Error("Unsupported stage");
      rawDefinition.value = {
        name: value.name,
        ...description,
      } as StageView & { name: string };
      if (
        (props.stage === "access" || props.stage === "upload") &&
        model.value.enabledParams === undefined
      )
        model.value.enabledParams = Object.keys(
          rawDefinition.value.paramsSchema?.properties ?? {},
        );
      if (!model.value.key)
        model.value.config = {
          ...defaults(description.configSchema),
          ...model.value.config,
        };
      model.value.secretEdits ??= {};
      for (const path of sensitivePaths(description.configSchema))
        model.value.secretEdits[path] ??= { action: "preserve" };
      emit("ready", true);
    } catch (e) {
      if (current === epoch) error.value = errorText(e);
    } finally {
      if (current === epoch) loading.value = false;
    }
  },
  { immediate: true },
);
</script>
<template>
  <div class="space-y-3">
    <label class="field"
      >{{ label
      }}<select
        :disabled="locked || upgrading || !!model.upgrade"
        v-model="choice"
        :aria-label="label"
        class="native-select"
        required
      >
        <option value="" disabled>{{ t("ui.selectAPlugin") }}</option>
        <option
          v-for="p in plugins.filter(
            (p) =>
              p.kind === kind &&
              (!stage || p.supportedStages?.includes(stage)) &&
              (!model.key ||
                p.id !== model.pluginId ||
                p.version === model.version),
          )"
          :key="p.id + '@' + p.version"
          :value="p.id + '@' + p.version"
        >
          {{ p.name }} · {{ p.version }}
        </option>
        <option
          v-if="
            choice && !plugins.some((p) => p.id + '@' + p.version === choice)
          "
          :value="choice"
        >
          {{ model.pluginId }} · {{ model.version }}{{ t("ui.notLoaded") }}
        </option>
      </select></label
    >
    <div
      v-if="!upgradeOnly && versions.length && !model.upgrade"
      class="space-y-2"
    >
      <p class="subtle">{{ t("plugins.upgradeSaved") }}</p>
      <div class="flex gap-2">
        <select
          v-model="targetVersion"
          class="native-select flex-1"
          :aria-label="t('plugins.targetVersion')"
          :disabled="upgrading"
        >
          <option value="">{{ t("plugins.targetVersion") }}</option>
          <option v-for="p in versions" :key="p.version" :value="p.version">
            {{ p.version }}
          </option>
        </select>
        <Button
          type="button"
          variant="outline"
          :disabled="!targetVersion || upgrading"
          @click="previewUpgrade"
          >{{ t("plugins.previewUpgrade") }}</Button
        >
      </div>
    </div>
    <div v-if="model.upgrade" class="space-y-2 border-l-2 border-primary pl-3">
      <p class="text-sm">
        {{ model.upgrade.fromVersion }} → {{ model.version }}
      </p>
      <p class="subtle">{{ t("plugins.upgradePending") }}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        v-if="!upgradeOnly"
        @click="cancelUpgrade"
        >{{ t("plugins.cancelUpgrade") }}</Button
      >
    </div>
    <ul
      v-if="model.upgrade && upgradeFields.length"
      class="text-sm text-destructive"
      role="alert"
    >
      <li v-for="field in upgradeFields" :key="field.path + field.message">
        {{ field.path }}: {{ field.message }}
      </li>
    </ul>
    <div
      v-if="model.upgrade && definition && removedParams.length"
      class="space-y-2"
    >
      <p class="subtle">{{ t("plugins.removedParams") }}</p>
      <label
        v-for="key in removedParams"
        :key="key"
        class="flex items-center gap-2 text-sm"
      >
        <input type="checkbox" v-model="model.enabledParams" :value="key" />{{
          key
        }}
      </label>
    </div>
    <p v-if="loading" class="subtle" role="status">{{ t("ui.loading") }}</p>
    <div v-if="error" role="alert" class="error-box">
      {{ error
      }}<Button type="button" variant="ghost" size="sm" @click="retry++">{{
        t("ui.retry")
      }}</Button>
    </div>
    <p v-if="model.error" class="text-sm text-destructive">
      {{ t("ui.savedButInitializationFailedEditAndSave") }}
    </p>
    <fieldset
      v-if="
        (stage === 'access' || stage === 'upload') && definition?.paramsSchema
      "
      class="space-y-3 py-2"
    >
      <legend class="text-sm font-medium">
        {{ t("plugins.requestParameters") }}
      </legend>
      <label
        v-for="(rule, key) in definition.paramsSchema.properties as Record<
          string,
          Config
        >"
        :key="key"
        class="mr-4 inline-flex items-center gap-2 text-sm"
      >
        <input
          type="checkbox"
          v-model="model.enabledParams"
          :value="key"
          :aria-label="t('plugins.enableParameter', { name: key })"
        />
        {{ rule.title ?? key }}
        <span class="text-xs text-muted-foreground">({{ key }})</span>
      </label>
    </fieldset>
    <SchemaField
      v-if="definition"
      :schema="definition.configSchema"
      :config="model.config"
      path=""
      :hints="definition.uiHints"
      :edits="model.secretEdits ?? {}"
      :secret-presence="model.secretPresence ?? {}"
      :editing="!!model.key && !model.upgrade"
      :configuration-key="model.key"
      :errors="errors?.length ? errors : upgradeFields"
    />
  </div>
</template>
