<script setup lang="ts">
import type { Field, Json, Manifest } from "@picloom/theme-sdk";
import type { Config } from "../../../shared/config";
import type { Schema } from "../../../shared/field-schema";
import { computed, ref, shallowRef } from "vue";
import { languageValue } from "../../../shared/theme-config";
import { languages } from "../../../shared/locales";
import { fieldText, messageText } from "../../../shared/package-localization";
import { t, locale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import TranslationDialog from "./TranslationDialog.vue";
import SchemaField from "./SchemaField.vue";
const props = defineProps<{
  field: Field;
  value?: Json;
  localization: Manifest;
  editingLocale: string;
  enabledLocales?: string[];
}>();
const emit = defineEmits<{ change: [value: Json | undefined] }>();
const root = computed(
  () => languageValue(props.field, props.value, props.editingLocale) as Config,
);
const editingLanguageName = computed(
  () =>
    languages.find((language) => language.tag === props.editingLocale)?.name ??
    props.editingLocale,
);
const editLanguages = computed(() =>
  languages.filter((language) =>
    props.localization.supportedLocales.includes(language.tag),
  ),
);
function translated(
  value: Json | undefined,
  next: Json | undefined,
  language: string,
) {
  const dictionary = { ...(value as Config) };
  if (next === undefined) delete dictionary[language];
  else dictionary[language] = next;
  return dictionary;
}
// The parent renders the field label, description and visibility once.
function scalar(schema: Schema): Schema {
  return {
    ...schema,
    "x-localized": false,
    "x-ui": { widget: schema["x-ui"]?.widget },
  };
}
const open = ref(false);
const target = shallowRef<{
  schema: Schema;
  path: string;
  label: string;
  change: (value: Json | undefined) => void;
}>();
const draft = ref<Config>({});
function edit(node: NonNullable<typeof target.value> & { value?: Json }) {
  target.value = node;
  draft.value = { ...(node.value as Config) };
  open.value = true;
}
const title = computed(() => {
  if (!target.value) return "";
  let schema: Field | undefined = props.field;
  const parts: string[] = [];
  for (const token of target.value.path.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (schema?.type === "array") {
      parts.push(t("fields.item", { number: Number(key) + 1 }));
      schema = schema.items;
    } else {
      schema = schema?.properties?.[key];
      parts.push(
        fieldText(props.localization, locale.value, schema?.["x-ui"] ?? {})
          .label ?? key,
      );
    }
  }
  return parts.join(" · ");
});
function confirm() {
  target.value?.change({ ...draft.value });
  open.value = false;
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
    <template #header="node">
      <div
        v-if="node.schema['x-localized']"
        class="flex flex-wrap items-center justify-between gap-2"
      >
        <label
          :for="node.id"
          class="relative pr-3 text-sm font-medium"
          :class="{ 'required-label': node.required }"
        >
          {{ node.label
          }}<span class="font-normal text-muted-foreground">
            · {{ editingLanguageName }}</span
          >
          <span v-if="node.schema['x-ui']?.groupKey" class="ml-2 subtle">{{
            messageText(localization, locale, node.schema["x-ui"].groupKey)
          }}</span>
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          :disabled="node.locked"
          :aria-label="t('ui.editTranslations') + ' · ' + node.label"
          @click="edit(node)"
          >{{ t("ui.editTranslations") }}</Button
        >
      </div>
    </template>
    <template #field="node">
      <SchemaField
        v-if="node.schema['x-localized']"
        :schema="scalar(node.schema)"
        :value="(node.value as Config)?.[editingLocale]"
        :input-id="node.id"
        :label="node.label + ' · ' + editingLanguageName"
        :required="node.required"
        :disabled="() => node.locked"
        :localization="localization"
        :root="root"
        @change="node.change(translated(node.value, $event, editingLocale))"
      />
    </template>
  </SchemaField>
  <TranslationDialog
    v-if="target"
    v-model:open="open"
    :title="title"
    :help="t('themes.translationHelp')"
    @confirm="confirm"
  >
    <SchemaField
      v-for="language in editLanguages"
      :key="language.tag"
      :schema="scalar(target.schema)"
      :value="draft[language.tag]"
      :path="'/' + language.tag"
      :label="
        language.name +
        (enabledLocales?.includes(language.tag) === false
          ? ' · ' + t('ui.languageDisabled')
          : '')
      "
      :localization="localization"
      @change="draft = translated(draft, $event, language.tag)"
    />
  </TranslationDialog>
</template>
