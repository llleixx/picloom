<script setup lang="ts">
import type { ParameterSchema } from "@picloom/plugin-sdk";
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Link, Plus, X, ExternalLink, LoaderCircle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, response, errorText } from "@/lib/api";
import { locale, t } from "@/lib/i18n";
import { localizePlugin } from "../../../shared/plugin-localization";
import { fieldText } from "../../../shared/package-localization";
import {
  initialValue,
  pointer,
  readPointer,
  type FieldHint,
  type AccessParameterGroup,
  type Config,
} from "../../../shared/config";
import {
  sameParameterConstraints,
  sameParameterDefault,
} from "../../../shared/parameter-fields";
import SchemaField from "./SchemaField.vue";
import CopyResult from "./CopyResult.vue";
import ImagePreview from "./ImagePreview.vue";
const props = defineProps<{ url: string }>();
const query = useQuery({
  queryKey: ["access-parameters"],
  queryFn: ({ signal }) =>
    api<AccessParameterGroup[]>("/api/access-parameters", { signal }),
  staleTime: 0,
});
const groups = computed(() =>
  (query.data.value ?? []).map((group) => localizePlugin(group, locale.value)),
);
const fields = computed(() => {
  const result = new Map<
    string,
    {
      key: string;
      schema: ParameterSchema;
      localization: AccessParameterGroup;
      groups: string[];
      conflict: boolean;
      defaultConflict: boolean;
    }
  >();
  for (const group of groups.value) {
    for (const [key, schema] of Object.entries(
      group.paramsSchema.properties ?? {},
    )) {
      const existing = result.get(key);
      if (existing) {
        existing.groups.push(group.name);
        existing.defaultConflict ||= !sameParameterDefault(
          existing.schema,
          schema,
        );
        existing.conflict ||= !sameParameterConstraints(
          existing.schema,
          schema,
        );
      } else
        result.set(key, {
          key,
          schema,
          localization: group,
          groups: [group.name],
          conflict: false,
          defaultConflict: false,
        });
    }
  }
  return result;
});
const selected = ref<string[]>([]),
  values = reactive<Config>({}),
  picker = ref(false),
  search = ref("");
const active = computed(() =>
  selected.value.flatMap((key) => {
    const field = fields.value.get(key);
    return field ? [field] : [];
  }),
);
const choices = computed(() =>
  groups.value
    .map((group) => ({
      ...group,
      fields: Object.keys(group.paramsSchema.properties ?? {})
        .filter((key) => !selected.value.includes(key))
        .map((key) => fields.value.get(key)!)
        .filter((field) =>
          `${field.key} ${fieldText(field.localization, locale.value, field.schema["x-ui"] as FieldHint | undefined).label ?? ""} ${group.name}`
            .toLowerCase()
            .includes(search.value.toLowerCase()),
        ),
    }))
    .filter((group) => group.fields.length),
);
function add(key: string) {
  if (!selected.value.includes(key)) selected.value.push(key);
  const rule = fields.value.get(key)!.schema;
  const field = fields.value.get(key)!;
  const value = field.defaultConflict ? undefined : initialValue(rule);
  if (value !== undefined) values[key] = value;
  picker.value = false;
  search.value = "";
}
function remove(key: string) {
  selected.value = selected.value.filter((item) => item !== key);
  delete values[key];
}
function clearParameters() {
  selected.value = [];
  for (const key of Object.keys(values)) delete values[key];
  picker.value = false;
  search.value = "";
  clearPreview();
}
const url = computed(() => {
  const result = new URL(props.url);
  for (const field of active.value) {
    const value = readPointer(values, "/" + pointer(field.key));
    if (!field.conflict && value !== undefined && value !== null)
      result.searchParams.set(field.key, String(value));
  }
  return result.href;
});
const preview = ref(""),
  busy = ref(false),
  error = ref("");
let controller: AbortController | undefined;
function clearPreview() {
  controller?.abort();
  controller = undefined;
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = "";
  busy.value = false;
  error.value = "";
}
watch(url, clearPreview);
onUnmounted(clearPreview);
async function showPreview() {
  clearPreview();
  const current = new AbortController();
  controller = current;
  busy.value = true;
  try {
    const target = new URL(url.value);
    const res = await response(target.pathname + target.search, {
      signal: current.signal,
    });
    const blob = await res.blob();
    if (current.signal.aborted) return;
    if (!blob.type.startsWith("image/"))
      throw new Error(t("ui.serverReturnedANonImageResponse"));
    preview.value = URL.createObjectURL(blob);
  } catch (e) {
    if (!current.signal.aborted) error.value = errorText(e);
  } finally {
    if (controller === current) busy.value = false;
  }
}
</script>
<template>
  <section class="my-6 space-y-4 border-t pt-5">
    <div class="flex items-center justify-between gap-2">
      <h3 class="flex items-center gap-2 font-medium">
        <Link :size="17" />{{ t("linkBuilder.title") }}
      </h3>
      <Button
        v-if="selected.length"
        type="button"
        variant="ghost"
        @click="clearParameters"
      >
        {{ t("linkBuilder.clear") }}
      </Button>
    </div>
    <CopyResult :url="url" :label="t('linkBuilder.title')" />
    <p v-if="fields.size" class="subtle">{{ t("linkBuilder.hint") }}</p>
    <p v-if="query.error.value" class="error-box">
      {{ errorText(query.error.value) }}
      <Button variant="ghost" @click="query.refetch()">{{
        t("ui.retry")
      }}</Button>
    </p>
    <LoaderCircle
      v-else-if="query.isPending.value"
      class="animate-spin"
      :size="16"
    />
    <template v-else-if="fields.size">
      <form class="space-y-4" @submit.prevent="showPreview">
        <div
          v-for="field in active"
          :key="field.key"
          class="rounded-md border p-3"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="subtle"
              >{{ field.groups.join(" · ") }} <code>{{ field.key }}</code></span
            >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              :aria-label="t('linkBuilder.remove') + ': ' + field.key"
              @click="remove(field.key)"
              ><X :size="15"
            /></Button>
          </div>
          <p v-if="field.defaultConflict" class="subtle">
            {{ t("linkBuilder.defaultConflict") }}
          </p>
          <SchemaField
            :schema="field.schema"
            :value="readPointer(values, '/' + pointer(field.key))"
            :root="values"
            :localization="field.localization"
            @change="
              (value) => {
                if (value === undefined) delete values[field.key];
                else values[field.key] = value;
              }
            "
            :path="'/' + pointer(field.key)"
            :label="field.key"
            :errors="[]"
          />
        </div>
        <div v-if="picker" class="space-y-3 rounded-md border bg-muted/30 p-3">
          <div class="flex gap-2">
            <Input
              v-model="search"
              :placeholder="t('linkBuilder.search')"
              :aria-label="t('linkBuilder.search')"
            /><Button
              type="button"
              size="icon"
              variant="ghost"
              :aria-label="t('linkBuilder.close')"
              @click="picker = false"
              ><X :size="16"
            /></Button>
          </div>
          <div class="max-h-64 space-y-3 overflow-y-auto">
            <div v-for="group in choices" :key="group.id">
              <p class="mb-1 text-xs font-medium text-muted-foreground">
                {{ group.name }}
              </p>
              <button
                v-for="field in group.fields"
                :key="field.key"
                type="button"
                :disabled="field.conflict"
                class="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                @click="add(field.key)"
              >
                <span
                  >{{
                    fieldText(
                      field.localization,
                      locale,
                      field.schema["x-ui"] as FieldHint | undefined,
                    ).label ?? field.key
                  }}
                  <span v-if="field.conflict" class="subtle">{{
                    t("linkBuilder.conflict")
                  }}</span></span
                ><code class="text-xs text-muted-foreground">{{
                  field.key
                }}</code>
              </button>
            </div>
            <p v-if="!choices.length" class="subtle">
              {{ t("linkBuilder.empty") }}
            </p>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button type="button" variant="outline" @click="picker = !picker"
            ><Plus :size="16" />{{ t("linkBuilder.add") }}</Button
          >
          <Button type="submit" variant="outline" :disabled="busy"
            ><LoaderCircle v-if="busy" class="animate-spin" :size="16" />{{
              t("ui.generatePreview")
            }}</Button
          >
          <a
            :href="url"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 px-2 text-sm text-primary"
            ><ExternalLink :size="15" />{{ t("linkBuilder.open") }}</a
          >
        </div>
      </form>
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <div v-if="preview" class="h-52 overflow-hidden rounded-lg border">
        <ImagePreview :src="preview" :contain="true" />
      </div>
    </template>
  </section>
</template>
