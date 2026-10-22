<script setup lang="ts">
import type { ParameterSchema } from "@picloom/plugin-sdk";
import type { PluginLocalization } from "@picloom/plugin-sdk";
import { t, locale } from "@/lib/i18n";
import { computed, onScopeDispose, ref, watch } from "vue";
import { Button } from "@/components/ui/button";
import PluginField from "./PluginField.vue";
import { fieldText } from "../../../shared/package-localization";
import { api, errorText } from "@/lib/api";
import { createPluginDraft } from "@/lib/plugin-draft";
import {
  sensitivePaths,
  type ConfiguredStep,
  type StageView,
  type PipelineKind,
  type PluginSummary,
  type PluginView,
  type UpgradePreview,
} from "../../../shared/config";
const model = defineModel<ConfiguredStep>({ required: true });
const props = defineProps<{
  plugins: (PluginSummary & { name: string })[];
  kind: "path" | "storage" | "processor";
  locked?: boolean;
  upgradeOnly?: boolean;
  stage?: PipelineKind;
  label: string;
  errors?: Array<{ path: string; message: string }>;
}>();
const emit = defineEmits<{ ready: [value: boolean] }>();
const definition = ref<StageView & PluginLocalization>();

const error = ref("");
let epoch = 0;
onScopeDispose(() => {
  ++epoch;
});
const retry = ref(0),
  loading = ref(false);
const choice = computed({
  get: () =>
    model.value.pluginId
      ? model.value.pluginId + "@" + model.value.version
      : "",
  set: (value: string) => {
    void selectPlugin(value);
  },
});
const selecting = ref(false);
const failedChoice = ref("");
const failedUpgrade = ref(false);
async function selectPlugin(value: string) {
  const plugin = props.plugins.find((p) => p.id + "@" + p.version === value);
  if (!plugin || selecting.value) return;
  const draft = model.value;
  const current = ++epoch;
  loading.value = false;
  selecting.value = true;
  failedUpgrade.value = false;
  emit("ready", false);
  error.value = "";
  failedChoice.value = "";
  try {
    const next = await createPluginDraft(
      plugin.id,
      plugin.version,
      props.stage,
    );
    if (current !== epoch || model.value !== draft) return;
    model.value = {
      ...next,
      ...("onNotApplicable" in draft
        ? { onNotApplicable: draft.onNotApplicable }
        : {}),
    };
  } catch (e) {
    if (current !== epoch || model.value !== draft) return;
    failedChoice.value = value;
    error.value = errorText(e);
  } finally {
    selecting.value = false;
  }
}
function retryLoad() {
  if (failedUpgrade.value) void previewUpgrade();
  else if (failedChoice.value) void selectPlugin(failedChoice.value);
  else retry.value++;
}

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
      !Object.hasOwn(definition.value?.paramsSchema?.properties ?? {}, key),
  ),
);
async function previewUpgrade() {
  if (!model.value.key || !targetVersion.value || upgrading.value) return;
  const draft = model.value;
  upgrading.value = true;
  failedUpgrade.value = false;
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
    if (model.value !== draft) return;
    failedUpgrade.value = true;
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
watch(
  () => [choice.value, model.value.key, model.value, props.stage, retry.value],
  async () => {
    const current = ++epoch;
    failedChoice.value = "";
    failedUpgrade.value = false;
    definition.value = undefined;
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
      definition.value = {
        ...description,
        defaultLocale: value.defaultLocale,
        messages: value.messages,
      };
      if (
        (props.stage === "access" || props.stage === "upload") &&
        model.value.enabledParams === undefined
      )
        model.value.enabledParams = Object.keys(
          definition.value.paramsSchema?.properties ?? {},
        );
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
        :disabled="locked || selecting || upgrading || !!model.upgrade"
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
    <p v-if="loading || selecting" class="subtle" role="status">
      {{ t("ui.loading") }}
    </p>
    <div v-if="error" role="alert" class="error-box">
      {{ error
      }}<Button type="button" variant="ghost" size="sm" @click="retryLoad">{{
        t("ui.retry")
      }}</Button>
    </div>
    <p v-if="model.error" class="text-sm text-destructive">
      {{ t("ui.savedButInitializationFailedEditAndSave") }}
    </p>
    <fieldset
      v-if="
        (stage === 'access' || stage === 'upload') &&
        definition?.paramsSchema &&
        Object.keys(definition.paramsSchema.properties ?? {}).length
      "
      class="space-y-3 py-2"
    >
      <legend class="text-sm font-medium">
        {{ t("plugins.requestParameters") }}
      </legend>
      <label
        v-for="(rule, key) in definition.paramsSchema.properties as Record<
          string,
          ParameterSchema
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
        {{ fieldText(definition, locale, rule["x-ui"]).label ?? key }}
        <span class="text-xs text-muted-foreground">({{ key }})</span>
      </label>
    </fieldset>
    <PluginField
      v-if="definition"
      :schema="definition.configSchema"
      :config="model.config"
      :localization="definition"
      :edits="model.secretEdits ?? {}"
      :secret-presence="model.secretPresence ?? {}"
      :editing="!!model.key && !model.upgrade"
      :configuration-key="model.key"
      :errors="errors?.length ? errors : upgradeFields"
    />
  </div>
</template>
