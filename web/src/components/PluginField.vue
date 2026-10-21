<script setup lang="ts">
import type { Schema } from "../../../shared/field-schema";
import SchemaField from "./SchemaField.vue";
import SecretField from "./SecretField.vue";
import { t } from "@/lib/i18n";
import { schemaNodes } from "../../../shared/package-localization";
import {
  sensitivePaths,
  type Config,
  type Json,
  type SecretEdit,
} from "../../../shared/config";
import type { MessageCatalog } from "../../../shared/package-localization";
const props = defineProps<{
  schema: Schema;
  config: Config;
  localization: MessageCatalog;
  secretPresence: Record<string, boolean>;
  edits: Record<string, SecretEdit>;
  editing: boolean;
  configurationKey?: string;
  errors: Array<{ path: string; message: string }>;
}>();
function sensitive(schema: Schema, path: string) {
  return path in props.secretPresence || sensitivePaths(schema).includes("");
}
function locked(_schema: Schema, path: string) {
  if (!props.editing) return false;
  let node = props.schema;
  if (node["x-immutable"]) return true;
  for (const key of path.split("/").slice(1)) {
    node = (
      node.type === "array"
        ? node.items
        : node.properties?.[key.replace(/~1/g, "/").replace(/~0/g, "~")]
    )!;
    if (node?.["x-immutable"]) return true;
  }
  return false;
}
function update(value: Json | undefined) {
  const next = (value ?? {}) as Config;
  for (const key of Object.keys(props.config))
    if (!(key in next)) delete props.config[key];
  Object.assign(props.config, next);
}
</script>
<template>
  <SchemaField
    :schema="schema"
    :value="config"
    :localization="localization"
    :errors="errors"
    :disabled="locked"
    :removable="(schema, path) => !sensitive(schema, path)"
    @change="update"
  >
    <template #field="field">
      <SecretField
        v-if="sensitive(field.schema, field.path)"
        :path="field.path"
        :label="field.label"
        :configuration-key="configurationKey"
        :configured="!!secretPresence[field.path]"
        :edit="edits[field.path]"
        :json-value="field.schema.type !== 'string'"
        :invalid="errors.some((e) => e.path === field.path)"
        :locked="field.locked"
        @update:edit="edits[field.path] = $event"
      />
    </template>
  </SchemaField>
  <p
    v-if="
      editing &&
      schemaNodes(schema).some(
        (node) => 'x-immutable' in node && node['x-immutable'],
      )
    "
    class="text-xs text-muted-foreground"
  >
    {{ t("ui.storageLocationIsFixedCreateANew") }}
  </p>
</template>
