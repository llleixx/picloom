<script setup lang="ts">
import SecretField from "./SecretField.vue";
import { t } from "@/lib/i18n";
import { computed, ref, useId, watch } from "vue";
import { ChevronRight, Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  cloneJson,
  readPointer,
  writePointer,
  pointer,
  type Config,
  type Json,
  type UIHints,
  type SecretEdit,
} from "../../../shared/config";
const props = defineProps<{
  schema: Config;
  config: Config;
  path: string;
  hints: UIHints;
  secretPresence: Record<string, boolean>;
  edits: Record<string, SecretEdit>;
  editing: boolean;
  configurationKey?: string;
  errors: Array<{ path: string; message: string }>;
  label?: string;
  required?: boolean;
  locked?: boolean;
}>();
const hint = computed(() => props.hints[props.path] ?? {}),
  visible = computed(
    () =>
      !hint.value.visibleWhen ||
      JSON.stringify(readPointer(props.config, hint.value.visibleWhen.path)) ===
        JSON.stringify(hint.value.visibleWhen.equals),
  );
const sensitive = computed(
  () =>
    props.path in props.secretPresence ||
    props.schema["x-sensitive"] === true ||
    (props.schema.type === "array" &&
      JSON.stringify(props.schema).includes('"x-sensitive":true')),
);
const immutable = computed(
  () => props.locked || (props.editing && props.schema["x-immutable"] === true),
);
const value = computed(() =>
  sensitive.value
    ? props.edits[props.path]?.value
    : readPointer(props.config, props.path),
);
const children = computed(() =>
  Object.entries(
    (props.schema.properties ?? {}) as Record<string, Config>,
  ).sort(
    ([a], [b]) =>
      (props.hints[props.path + "/" + pointer(a)]?.order ?? 0) -
      (props.hints[props.path + "/" + pointer(b)]?.order ?? 0),
  ),
);
function set(value: Json | undefined) {
  if (sensitive.value) {
    const edit = props.edits[props.path];
    if (edit) edit.value = value;
  } else writePointer(props.config, props.path, value);
}
const showAdvanced = ref(false);
const advancedId = useId();
const regularChildren = computed(() =>
  children.value.filter(
    ([key]) => !props.hints[props.path + "/" + pointer(key)]?.advanced,
  ),
);
const advancedChildren = computed(() =>
  children.value.filter(
    ([key]) => props.hints[props.path + "/" + pointer(key)]?.advanced,
  ),
);
watch(
  () => props.errors,
  (errors) => {
    if (
      advancedChildren.value.some(([key]) =>
        errors.some(
          (error) =>
            error.path === props.path + "/" + pointer(key) ||
            error.path.startsWith(props.path + "/" + pointer(key) + "/"),
        ),
      )
    )
      showAdvanced.value = true;
  },
  { immediate: true },
);
const invalid = computed(() =>
  props.errors.some((error) => error.path === props.path),
);
function initial(rule: Config): Json {
  return rule.default !== undefined
    ? cloneJson(rule.default)
    : rule.type === "object"
      ? {}
      : rule.type === "array"
        ? []
        : rule.type === "boolean"
          ? false
          : rule.type === "number" || rule.type === "integer"
            ? 0
            : "";
}
function append() {
  const items = Array.isArray(value.value) ? [...value.value] : [];
  items.push(initial(props.schema.items as Config));
  set(items);
}
</script>
<template>
  <div v-if="visible" class="space-y-2">
    <div v-if="path" class="flex items-center justify-between gap-2">
      <label
        :for="'field' + path"
        class="relative pr-3 text-sm font-medium"
        :class="{ 'required-label': required }"
        >{{ schema.title ?? label ?? path
        }}<span v-if="hint.group" class="ml-2 text-xs text-muted-foreground">{{
          hint.group
        }}</span
        ><span
          v-if="hint.advanced"
          class="ml-2 text-xs text-muted-foreground"
          >{{ t("ui.advanced") }}</span
        ></label
      ><Button
        v-if="!required && !sensitive && !immutable && value !== undefined"
        type="button"
        size="sm"
        variant="ghost"
        @click="set(undefined)"
        >{{ t("ui.removeField") }}</Button
      >
    </div>
    <p v-if="schema.description" class="subtle">{{ schema.description }}</p>
    <SecretField
      v-if="sensitive"
      :path="path"
      :label="String(schema.title ?? label ?? path)"
      :configuration-key="configurationKey"
      :configured="!!secretPresence[path]"
      :edit="edits[path]"
      :json-value="schema.type !== 'string'"
      :invalid="invalid"
      :locked="immutable"
      @update:edit="edits[path] = $event"
    />
    <template v-else-if="schema.type === 'object'">
      <div class="space-y-4" :class="path ? 'border-l pl-4' : ''">
        <SchemaField
          v-for="[key, rule] in regularChildren"
          :key="key"
          :schema="rule"
          :path="path + '/' + pointer(key)"
          :label="key"
          :required="(schema.required as string[] | undefined)?.includes(key)"
          :config="config"
          :hints="hints"
          :secret-presence="secretPresence"
          :edits="edits"
          :editing="editing"
          :configuration-key="configurationKey"
          :locked="immutable"
          :errors="errors"
        />
        <Button
          v-if="advancedChildren.length"
          type="button"
          size="sm"
          variant="ghost"
          :aria-expanded="showAdvanced"
          :aria-controls="advancedId"
          @click="showAdvanced = !showAdvanced"
        >
          <ChevronRight
            class="size-4 transition-transform"
            :class="{ 'rotate-90': showAdvanced }"
            aria-hidden="true"
          />
          {{ showAdvanced ? t("ui.hideAdvanced") : t("ui.showAdvanced") }}
        </Button>
        <div
          v-if="advancedChildren.length"
          v-show="showAdvanced"
          :id="advancedId"
          class="space-y-4"
        >
          <SchemaField
            v-for="[key, rule] in advancedChildren"
            :key="key"
            :schema="rule"
            :path="path + '/' + pointer(key)"
            :label="key"
            :required="(schema.required as string[] | undefined)?.includes(key)"
            :config="config"
            :hints="hints"
            :secret-presence="secretPresence"
            :edits="edits"
            :editing="editing"
            :configuration-key="configurationKey"
            :locked="immutable"
            :errors="errors"
          />
        </div>
      </div>
    </template>
    <template v-else-if="schema.type === 'array'">
      <div class="space-y-3 border-t py-4">
        <div
          v-for="(_, index) in Array.isArray(value) ? value : []"
          :key="index"
          class="space-y-2 border-b pb-3"
        >
          <SchemaField
            :schema="schema.items as Config"
            :path="path + '/' + index"
            :label="t('fields.item', { number: index + 1 })"
            :config="config"
            :hints="hints"
            :secret-presence="secretPresence"
            :edits="edits"
            :editing="editing"
            :configuration-key="configurationKey"
            :locked="immutable"
            :errors="errors"
          /><Button
            v-if="!immutable"
            type="button"
            size="sm"
            variant="ghost"
            @click="set((value as Json[]).filter((_, n) => n !== index))"
            >{{ t("ui.removeItem") }}</Button
          >
        </div>
        <Button
          v-if="!immutable"
          type="button"
          variant="outline"
          size="sm"
          @click="append"
          ><Plus />{{ t("ui.addItem") }}</Button
        >
      </div>
    </template>
    <select
      v-else-if="schema.enum"
      :id="'field' + path"
      :aria-invalid="invalid || undefined"
      :aria-label="String(schema.title ?? label ?? path)"
      :disabled="immutable"
      class="native-select w-full"
      :value="value === undefined ? '__unset' : JSON.stringify(value)"
      @change="
        set(
          ($event.target as HTMLSelectElement).value === '__unset'
            ? undefined
            : JSON.parse(($event.target as HTMLSelectElement).value),
        )
      "
    >
      <option v-if="!required" value="__unset">{{ t("ui.notSet") }}</option>
      <option
        v-for="(option, index) in schema.enum as Json[]"
        :key="JSON.stringify(option)"
        :value="JSON.stringify(option)"
      >
        {{
          (schema["x-enumLabels"] as string[] | undefined)?.[index] ?? option
        }}
      </option>
    </select>
    <Button
      v-else-if="schema.type === 'null'"
      type="button"
      variant="outline"
      :disabled="immutable"
      @click="set(null)"
      >{{ t("ui.setToNull") }}</Button
    >
    <label
      v-else-if="schema.type === 'boolean'"
      class="flex items-center gap-2 text-sm"
      ><input
        :id="'field' + path"
        :aria-invalid="invalid || undefined"
        :aria-label="String(schema.title ?? label ?? path)"
        type="checkbox"
        :checked="!!value"
        :disabled="immutable"
        @change="set(($event.target as HTMLInputElement).checked)"
      />{{ t("ui.enabled") }}</label
    >
    <textarea
      v-else-if="hint.widget === 'textarea'"
      :id="'field' + path"
      :aria-invalid="invalid || undefined"
      :aria-label="String(schema.title ?? label ?? path)"
      :value="value as string"
      :disabled="immutable"
      class="native-select h-24 w-full"
      @input="set(($event.target as HTMLTextAreaElement).value)"
    />
    <Input
      v-else
      :id="'field' + path"
      :aria-invalid="invalid || undefined"
      :aria-label="String(schema.title ?? label ?? path)"
      :model-value="(value ?? '') as string | number"
      :disabled="immutable"
      :type="
        ['integer', 'number'].includes(String(schema.type))
          ? 'number'
          : hint.widget === 'password'
            ? 'password'
            : 'text'
      "
      :min="schema.minimum as number"
      :max="schema.maximum as number"
      :step="schema.type === 'integer' ? 1 : 'any'"
      @update:model-value="
        set(
          ['integer', 'number'].includes(String(schema.type))
            ? $event === ''
              ? undefined
              : Number($event)
            : String($event),
        )
      "
    />
    <p v-if="immutable" class="text-xs text-muted-foreground">
      {{ t("ui.storageLocationIsFixedCreateANew") }}
    </p>
    <p
      v-for="error in errors.filter((e) => e.path === path)"
      :key="error.message"
      class="text-xs text-destructive"
    >
      {{ error.message }}
    </p>
  </div>
</template>
