<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import { Eye, EyeOff, X, LoaderCircle } from "lucide-vue-next";
import type { Json, SecretEdit } from "../../../shared/config";
import { api, errorText } from "@/lib/api";
import { t } from "@/lib/i18n";
const props = defineProps<{
  path: string;
  label: string;
  configurationKey?: string;
  configured: boolean;
  edit?: SecretEdit;
  jsonValue: boolean;
  invalid: boolean;
  locked?: boolean;
}>();
const emit = defineEmits<{ "update:edit": [value: SecretEdit] }>();
const input = ref<HTMLInputElement>();
const draft = ref(""),
  visible = ref(false),
  loading = ref(false),
  error = ref("");
let controller: AbortController | undefined;
const format = (value: Json | undefined) =>
  value === undefined
    ? ""
    : props.jsonValue
      ? JSON.stringify(value)
      : String(value);
watch(
  () => [props.configurationKey, props.path, props.edit],
  () => {
    controller?.abort();
    loading.value = false;
    draft.value =
      props.edit?.action === "replace" ? format(props.edit.value) : "";
    error.value = "";
    input.value?.setCustomValidity("");
  },
  { immediate: true },
);
watch(
  () => [props.configurationKey, props.path],
  () => {
    visible.value = false;
  },
);
onUnmounted(() => controller?.abort());
function update(event: Event) {
  const element = event.target as HTMLInputElement;
  draft.value = element.value;
  error.value = "";
  element.setCustomValidity("");
  if (!draft.value) {
    emit("update:edit", { action: "clear" });
    return;
  }
  try {
    const value: Json = props.jsonValue ? JSON.parse(draft.value) : draft.value;
    emit("update:edit", { action: "replace", value });
  } catch {
    error.value = t("ui.enterValidJson");
    element.setCustomValidity(error.value);
  }
}
function clear() {
  visible.value = false;
  emit("update:edit", { action: "clear" });
}
async function toggle() {
  if (visible.value) {
    visible.value = false;
    return;
  }
  if (
    props.edit?.action !== "clear" &&
    props.edit?.action !== "replace" &&
    props.configured &&
    props.configurationKey &&
    !draft.value
  ) {
    controller?.abort();
    const request = (controller = new AbortController());
    loading.value = true;
    error.value = "";
    try {
      const result = await api<{ value?: Json }>(
        `/api/plugin-configurations/${encodeURIComponent(props.configurationKey)}/reveal-secret`,
        {
          method: "POST",
          body: JSON.stringify({ path: props.path }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      draft.value = format(result.value);
      visible.value = true;
    } catch (e) {
      if (!request.signal.aborted) error.value = errorText(e);
    } finally {
      if (!request.signal.aborted) loading.value = false;
    }
  } else visible.value = true;
}
</script>
<template>
  <div class="space-y-2">
    <div class="relative">
      <input
        ref="input"
        :id="'field' + path"
        :aria-label="label"
        :aria-invalid="invalid || !!error || undefined"
        :value="draft"
        :type="visible ? 'text' : 'password'"
        autocomplete="new-password"
        spellcheck="false"
        :disabled="loading || locked"
        class="native-select h-9 w-full pr-20"
        :placeholder="
          configured && edit?.action !== 'clear' ? '••••••••' : undefined
        "
        @input="update"
      />
      <div class="absolute inset-y-0 right-1 flex items-center">
        <button
          v-if="!locked && (draft || (configured && edit?.action !== 'clear'))"
          type="button"
          class="rounded p-2 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          :disabled="loading"
          :aria-label="t('fields.clearSecret', { label })"
          @click="clear"
        >
          <X class="size-4" />
        </button>
        <button
          type="button"
          class="rounded p-2 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          :disabled="loading"
          :aria-label="
            t(visible ? 'fields.hideSecret' : 'fields.showSecret', { label })
          "
          :aria-pressed="visible"
          @click="toggle"
        >
          <LoaderCircle v-if="loading" class="size-4 animate-spin" /><EyeOff
            v-else-if="visible"
            class="size-4"
          /><Eye v-else class="size-4" />
        </button>
      </div>
    </div>
    <p v-if="edit?.action === 'clear' && configured" class="subtle">
      {{ t("fields.secretCleared") }}
    </p>
    <p v-else-if="configured && edit?.action !== 'replace'" class="subtle">
      {{ t("fields.secretUnchanged") }}
    </p>
    <p v-if="jsonValue" class="subtle">{{ t("ui.jsonValue") }}</p>
    <p v-if="error" role="alert" class="error-box">{{ error }}</p>
  </div>
</template>
