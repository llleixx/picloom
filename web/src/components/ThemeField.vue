<script setup lang="ts">
import type { Field, Json, Manifest } from "../../../theme-sdk";
import type { Config } from "../../../shared/config";
import { computed } from "vue";
import { languageValue } from "../../../shared/theme-config";
import SchemaField from "./SchemaField.vue";
const props = defineProps<{
  field: Field;
  value?: Json;
  localization: Manifest;
  editingLocale: string;
}>();
const emit = defineEmits<{ change: [value: Json | undefined] }>();
const root = computed(
  () => languageValue(props.field, props.value, props.editingLocale) as Config,
);
function translated(value: Json | undefined, next: Json | undefined) {
  const dictionary = { ...(value as Config) };
  if (next === undefined) delete dictionary[props.editingLocale];
  else dictionary[props.editingLocale] = next;
  return dictionary;
}
</script>
<template>
  <SchemaField
    :schema="field"
    :value="value"
    :root="root"
    :removable="(schema) => !schema['x-localized']"
    :localization="localization"
    @change="emit('change', $event)"
  >
    <template #field="node">
      <SchemaField
        v-if="node.schema['x-localized']"
        :schema="{ ...node.schema, 'x-localized': false }"
        :value="(node.value as Config)?.[editingLocale]"
        :path="node.path + '/' + editingLocale"
        :label="node.label"
        :localization="localization"
        :root="root"
        @change="node.change(translated(node.value, $event))"
      />
    </template>
  </SchemaField>
</template>
