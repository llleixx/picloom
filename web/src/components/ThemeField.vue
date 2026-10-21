<script setup lang="ts">
import type { Field, Json } from "../../../theme-sdk";
import { computed, type PropType } from "vue";
import { locale } from "../lib/i18n";
const props = defineProps({
  field: { type: Object as PropType<Field>, required: true },
  value: { type: null as unknown as PropType<Json | undefined> },
  name: { type: String, required: true },
  editingLocale: String,
  defaultLocale: { type: String, required: true },
  mode: String as PropType<"ordinary" | "localized">,
});
const emit = defineEmits<{ change: [value: Json] }>();
const content = computed(() => ({
  ...props.field.content?.[props.defaultLocale],
  ...props.field.content?.[locale.value],
}));
const label = computed(
  () => content.value?.title ?? props.field.title ?? props.name,
);
function child(key: string, value: Json) {
  emit("change", {
    ...((props.value as Record<string, Json>) ?? {}),
    [key]: value,
  });
}
function visible(field: Field): boolean {
  if (!props.mode) return true;
  if (field.type === "object")
    return Object.values(field.properties ?? {}).some(visible);
  return Boolean(field["x-localized"]) === (props.mode === "localized");
}
</script>
<template>
  <fieldset
    v-if="visible(field) && field.type === 'object'"
    class="space-y-4 rounded-lg border p-4"
  >
    <legend class="px-2 font-medium">{{ label }}</legend>
    <ThemeField
      v-for="(f, key) in field.properties"
      :key="key"
      :field="f"
      :name="String(key)"
      :default-locale="defaultLocale"
      :value="(value as Record<string, Json>)?.[key]"
      :editing-locale="editingLocale"
      :mode="mode"
      @change="child(String(key), $event)"
    />
  </fieldset>
  <div v-else-if="visible(field) && field['x-localized']">
    <ThemeField
      :field="{ ...field, 'x-localized': false }"
      :name="name"
      :default-locale="defaultLocale"
      :value="(value as Record<string, Json>)?.[editingLocale!]"
      @change="child(editingLocale!, $event)"
    />
  </div>
  <label v-else-if="visible(field)" class="field"
    >{{ label }}
    <select
      v-if="field.enum"
      class="native-select"
      :value="field.enum.indexOf(value as string)"
      @change="
        emit(
          'change',
          field.enum![Number(($event.target as HTMLSelectElement).value)]!,
        )
      "
    >
      <option value="-1" disabled>—</option>
      <option v-for="(option, index) in field.enum" :key="index" :value="index">
        {{
          content?.enumLabels?.[index] ??
          field.content?.[defaultLocale]?.enumLabels?.[index] ??
          option
        }}
      </option>
    </select>
    <input
      v-else-if="field.type === 'boolean'"
      type="checkbox"
      :checked="Boolean(value)"
      @change="emit('change', ($event.target as HTMLInputElement).checked)"
    />
    <textarea
      v-else-if="field['x-multiline']"
      class="native-select"
      :value="String(value ?? '')"
      :maxlength="field.maxLength"
      :minlength="field.minLength"
      @input="emit('change', ($event.target as HTMLTextAreaElement).value)"
    />
    <input
      v-else
      class="native-select"
      :type="field.type === 'string' ? 'text' : 'number'"
      :value="value as string"
      :min="field.minimum"
      :max="field.maximum"
      :maxlength="field.maxLength"
      :minlength="field.minLength"
      :step="field.type === 'integer' ? 1 : 'any'"
      @input="
        emit(
          'change',
          field.type === 'string'
            ? ($event.target as HTMLInputElement).value
            : Number(($event.target as HTMLInputElement).value),
        )
      "
    />
    <span class="text-xs text-muted-foreground">{{
      content?.description ?? field.description
    }}</span>
  </label>
</template>
