<script setup lang="ts">
import { computed, ref, useId, watch, type PropType } from "vue";
import { equalJson, type Schema } from "../../../shared/field-schema";
import { t, locale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  initialValue,
  pointer,
  readPointer,
  type Config,
  type Json,
  type FieldHint,
} from "../../../shared/config";
import {
  fieldText,
  messageText,
  type MessageCatalog,
} from "../../../shared/package-localization";
// A JSON value must not undergo Vue's Boolean-prop casting ("" must stay "").
const props = defineProps({
  schema: { type: Object as PropType<Schema>, required: true },
  value: { type: null as unknown as PropType<Json | undefined> },
  path: { type: String, default: "" },
  label: String,
  inputId: String,
  required: Boolean,
  localization: { type: Object as PropType<MessageCatalog>, required: true },
  root: Object as PropType<Config>,
  errors: {
    type: Array as PropType<Array<{ path: string; message: string }>>,
    default: () => [],
  },
  disabled: Function as PropType<(schema: Schema, path: string) => boolean>,
  removable: Function as PropType<(schema: Schema, path: string) => boolean>,
});
const emit = defineEmits<{ change: [value: Json | undefined] }>();
type FieldNode = {
  schema: Schema;
  path: string;
  value: Json | undefined;
  label: string;
  required: boolean | undefined;
  locked: boolean;
  change: (value: Json | undefined) => void;
};
defineSlots<{
  field(props: FieldNode & { id: string }): any;
  header(props: FieldNode & { id: string }): any;
}>();
const generatedId = useId();
const id = computed(() => props.inputId ?? generatedId);
const hint = computed<FieldHint>(() => props.schema["x-ui"] ?? {});
const text = computed(() =>
  fieldText(props.localization, locale.value, hint.value),
);
const label = computed(() => text.value.label ?? props.label ?? props.path);
const root = computed(() => props.root ?? (props.value as Config) ?? {});
const locked = computed(
  () => props.disabled?.(props.schema, props.path) ?? false,
);
const visible = computed(
  () =>
    !hint.value.visibleWhen ||
    equalJson(
      readPointer(root.value, hint.value.visibleWhen.path),
      hint.value.visibleWhen.equals,
    ),
);
const children = computed(() =>
  Object.entries(props.schema.properties ?? {}).sort(
    ([, a], [, b]) => (a["x-ui"]?.order ?? 0) - (b["x-ui"]?.order ?? 0),
  ),
);
const advanced = ref(false);
watch(
  () => props.errors,
  (errors) => {
    if (
      children.value.some(
        ([key, rule]) =>
          rule["x-ui"]?.advanced &&
          errors.some(
            (error) =>
              error.path === props.path + "/" + pointer(key) ||
              error.path.startsWith(props.path + "/" + pointer(key) + "/"),
          ),
      )
    )
      advanced.value = true;
  },
  { immediate: true },
);
// Row identity follows structural edits so nested drafts move with their item.
let nextRowKey = 0;
const rowKeys = ref<number[]>([]);
watch(
  () => (Array.isArray(props.value) ? props.value.length : 0),
  (length) => {
    rowKeys.value.length = Math.min(rowKeys.value.length, length);
    while (rowKeys.value.length < length) rowKeys.value.push(nextRowKey++);
  },
  { immediate: true, flush: "sync" },
);
const pending = ref(false);
const pendingValue = ref<Json>();
const invalid = computed(() =>
  props.errors.some((error) => error.path === props.path),
);
const options = computed(() => props.schema.enum as Json[] | undefined);
const selectedOption = computed(() => {
  const option = options.value?.find((value) => equalJson(value, props.value));
  return option === undefined ? "__unset" : JSON.stringify(option);
});
function set(value: Json | undefined) {
  emit("change", value);
}
function child(key: string, value: Json | undefined) {
  if (props.schema.type === "array") {
    if (value === undefined) return; // Removing array items is an explicit structural operation.
    const next = [...(props.value as Json[])];
    next[Number(key)] = value;
    set(next);
  } else {
    if (value === undefined && props.value === undefined) return;
    const next = { ...((props.value as Config) ?? {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    set(next);
  }
}
function append() {
  const rule = props.schema.items!;
  let value = initialValue(rule);
  if (value === undefined && rule.type === "object") value = {};
  if (value === undefined) {
    pendingValue.value = undefined;
    pending.value = true;
  } else set([...(Array.isArray(props.value) ? props.value : []), value]);
}
function finish(value: Json | undefined) {
  if (value === undefined) return;
  set([...(Array.isArray(props.value) ? props.value : []), value]);
  pending.value = false;
}
function remove(index: number) {
  rowKeys.value.splice(index, 1);
  set((props.value as Json[]).filter((_, n) => n !== index));
}
function move(index: number, delta: number) {
  const items = [...(props.value as Json[])];
  [items[index], items[index + delta]] = [items[index + delta]!, items[index]!];
  [rowKeys.value[index], rowKeys.value[index + delta]] = [
    rowKeys.value[index + delta]!,
    rowKeys.value[index]!,
  ];
  set(items);
}
</script>
<template>
  <div v-if="visible" class="space-y-2">
    <slot
      v-if="path"
      name="header"
      :schema="schema"
      :path="path"
      :value="value"
      :label="label"
      :required="required"
      :locked="locked"
      :change="set"
      :id="id"
    >
      <div class="flex items-center justify-between gap-2">
        <label
          :for="id"
          class="relative pr-3 text-sm font-medium"
          :class="{ 'required-label': required }"
          >{{ label
          }}<span v-if="hint.groupKey" class="ml-2 subtle">{{
            messageText(localization, locale, hint.groupKey)
          }}</span></label
        >
        <Button
          v-if="
            !required &&
            !locked &&
            value !== undefined &&
            (removable?.(schema, path) ?? true)
          "
          type="button"
          size="sm"
          variant="ghost"
          @click="set(undefined)"
          >{{ t("ui.removeField") }}</Button
        >
      </div>
    </slot>
    <p v-if="text.description" class="subtle">{{ text.description }}</p>
    <slot
      name="field"
      :id="id"
      :schema="schema"
      :path="path"
      :value="value"
      :label="label"
      :required="required"
      :locked="locked"
      :change="set"
    >
      <select
        v-if="options"
        :id="id"
        :aria-label="label"
        :aria-invalid="invalid || undefined"
        :disabled="locked"
        class="native-select w-full"
        :value="selectedOption"
        @change="
          set(
            ($event.target as HTMLSelectElement).value === '__unset'
              ? undefined
              : JSON.parse(($event.target as HTMLSelectElement).value),
          )
        "
      >
        <option value="__unset" :disabled="required">
          {{ t("ui.notSet") }}
        </option>
        <option
          v-for="(option, index) in options"
          :key="JSON.stringify(option)"
          :value="JSON.stringify(option)"
        >
          {{
            text.enumLabels?.[index] ??
            (typeof option === "object"
              ? JSON.stringify(option)
              : String(option))
          }}
        </option>
      </select>
      <template v-else-if="schema.type === 'object'">
        <div class="space-y-4" :class="path ? 'border-l pl-4' : ''">
          <Button
            v-if="value === undefined && children.length === 0"
            type="button"
            variant="outline"
            :disabled="locked"
            @click="set({})"
            >{{ t("ui.setEmptyObject") }}</Button
          >
          <template v-for="[key, rule] in children" :key="key">
            <SchemaField
              v-if="!rule['x-ui']?.advanced || advanced"
              :schema="rule"
              :value="readPointer((value ?? {}) as Config, '/' + pointer(key))"
              :path="path + '/' + pointer(key)"
              :label="key"
              :required="
                (schema.required as string[] | undefined)?.includes(key)
              "
              :root="root"
              :localization="localization"
              :errors="errors"
              :disabled="disabled"
              :removable="removable"
              @change="child(key, $event)"
            >
              <template #header="header"
                ><slot name="header" v-bind="header"
              /></template>
              <template #field="field"
                ><slot name="field" v-bind="field"
              /></template>
            </SchemaField>
          </template>
          <Button
            v-if="children.some(([, rule]) => rule['x-ui']?.advanced)"
            type="button"
            size="sm"
            variant="ghost"
            :aria-expanded="advanced"
            @click="advanced = !advanced"
            >{{
              advanced ? t("ui.hideAdvanced") : t("ui.showAdvanced")
            }}</Button
          >
        </div>
      </template>
      <template v-else-if="schema.type === 'array'">
        <div
          v-for="(item, index) in Array.isArray(value) ? value : []"
          :key="rowKeys[index]"
          class="space-y-2 border-l pl-4"
        >
          <SchemaField
            :schema="schema.items!"
            :value="item"
            :path="path + '/' + index"
            :label="t('fields.item', { number: index + 1 })"
            required
            :root="root"
            :localization="localization"
            :errors="errors"
            :disabled="disabled"
            :removable="removable"
            @change="child(String(index), $event)"
          >
            <template #header="header"
              ><slot name="header" v-bind="header"
            /></template>
            <template #field="field"
              ><slot name="field" v-bind="field"
            /></template>
          </SchemaField>
          <div v-if="!locked" class="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              @click="remove(index)"
              >{{ t("ui.removeItem") }}</Button
            >
            <Button
              v-if="index > 0"
              type="button"
              size="sm"
              variant="ghost"
              :aria-label="t('ui.moveItemUp')"
              @click="move(index, -1)"
              >↑</Button
            >
            <Button
              v-if="index + 1 < (value as Json[]).length"
              type="button"
              size="sm"
              variant="ghost"
              :aria-label="t('ui.moveItemDown')"
              @click="move(index, 1)"
              >↓</Button
            >
          </div>
        </div>
        <SchemaField
          v-if="pending && !locked"
          :schema="schema.items!"
          :path="path + '/' + (Array.isArray(value) ? value.length : 0)"
          :label="t('ui.newItem')"
          :value="pendingValue"
          required
          :localization="localization"
          :root="root"
          @change="pendingValue = $event"
        >
          <template #header="header"
            ><slot name="header" v-bind="header"
          /></template>
          <template #field="field"
            ><slot name="field" v-bind="field"
          /></template>
        </SchemaField>
        <Button
          v-if="pending"
          type="button"
          :disabled="pendingValue === undefined"
          @click="finish(pendingValue)"
          >{{ t("ui.addItem") }}</Button
        >
        <Button
          v-if="pending"
          type="button"
          variant="ghost"
          @click="pending = false"
          >{{ t("ui.cancel") }}</Button
        >
        <Button
          v-if="!locked && !pending"
          type="button"
          size="sm"
          variant="outline"
          @click="append"
          >{{ t("ui.addItem") }}</Button
        >
      </template>
      <Button
        v-else-if="schema.type === 'null'"
        type="button"
        variant="outline"
        :disabled="locked"
        @click="set(null)"
        >{{ t("ui.setToNull") }}</Button
      >
      <select
        v-else-if="schema.type === 'boolean'"
        :id="id"
        :aria-label="label"
        :aria-invalid="invalid || undefined"
        class="native-select w-full"
        :disabled="locked"
        :value="value === undefined ? '__unset' : String(value)"
        @change="
          set(
            ($event.target as HTMLSelectElement).value === '__unset'
              ? undefined
              : ($event.target as HTMLSelectElement).value === 'true',
          )
        "
      >
        <option
          v-if="!required || value === undefined"
          value="__unset"
          :disabled="required"
        >
          {{ t("ui.notSet") }}
        </option>
        <option value="true">{{ t("ui.enabled") }}</option>
        <option value="false">{{ t("ui.disabled") }}</option>
      </select>
      <textarea
        v-else-if="hint.widget === 'textarea'"
        :id="id"
        :aria-label="label"
        :aria-invalid="invalid || undefined"
        :value="value as string"
        :disabled="locked"
        class="native-select h-24 w-full"
        :minlength="schema.minLength as number"
        :maxlength="schema.maxLength as number"
        @input="set(($event.target as HTMLTextAreaElement).value)"
      />
      <Input
        v-else
        :id="id"
        :aria-label="label"
        :aria-invalid="invalid || undefined"
        :model-value="(value ?? '') as string | number"
        :disabled="locked"
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
        :minlength="schema.minLength as number"
        :maxlength="schema.maxLength as number"
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
    </slot>
    <p
      v-for="error in errors.filter((e) => e.path === path)"
      :key="error.message"
      class="text-xs text-destructive"
    >
      {{ error.message }}
    </p>
  </div>
</template>
