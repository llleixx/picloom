<script setup lang="ts">
import type { ParameterSchema } from "@picloom/plugin-sdk";
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  LoaderCircle,
} from "lucide-vue-next";
import {
  ComboboxRoot,
  ComboboxAnchor,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPortal,
  ComboboxContent,
  ComboboxItem,
  ComboboxItemIndicator,
} from "reka-ui";
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
  (query.data.value ?? [])
    .filter((group) => Object.keys(group.paramsSchema.properties ?? {}).length)
    .map((group) => localizePlugin(group, locale.value)),
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
const plugin = ref("");
const pluginSearch = ref("");
const pluginOpen = ref(false);
watch(
  groups,
  (items) => {
    if (
      plugin.value !== "all" &&
      !items.some((group) => group.id === plugin.value)
    )
      plugin.value = items[0]?.id ?? "";
  },
  { immediate: true },
);
watch(plugin, () => {
  picker.value = false;
  search.value = "";
});
function groupCount(group: AccessParameterGroup) {
  return selected.value.filter((key) =>
    Object.hasOwn(group.paramsSchema.properties ?? {}, key),
  ).length;
}
const pluginOptions = computed(() =>
  [
    {
      id: "all",
      name: t("linkBuilder.selected"),
      count: selected.value.length,
    },
    ...groups.value.map((group) => ({
      id: group.id,
      name: group.name,
      count: groupCount(group),
    })),
  ].filter((option) =>
    option.name
      .toLocaleLowerCase()
      .includes(pluginSearch.value.trim().toLocaleLowerCase()),
  ),
);
function pluginLabel(value: unknown) {
  return value === "all"
    ? t("linkBuilder.selected")
    : (groups.value.find((group) => group.id === value)?.name ?? "");
}
const sections = computed(() => {
  const seen = new Set<string>();
  return groups.value
    .filter((group) => plugin.value === "all" || group.id === plugin.value)
    .map((group) => ({
      ...group,
      fields: selected.value.flatMap((key) => {
        if (
          !Object.hasOwn(group.paramsSchema.properties ?? {}, key) ||
          seen.has(key)
        )
          return [];
        seen.add(key);
        const field = fields.value.get(key);
        return field ? [field] : [];
      }),
    }));
});
const active = computed(() =>
  selected.value.flatMap((key) => {
    const field = fields.value.get(key);
    return field ? [field] : [];
  }),
);
const choices = computed(() =>
  groups.value
    .filter((group) => group.id === plugin.value)
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
  <section class="space-y-3">
    <CopyResult :url="url" :label="t('linkBuilder.title')" open-link />
    <p v-if="query.error.value" class="error-box">
      {{ errorText(query.error.value) }}
      <Button variant="ghost" size="sm" @click="query.refetch()">{{
        t("ui.retry")
      }}</Button>
    </p>
    <LoaderCircle
      v-else-if="query.isPending.value"
      class="animate-spin"
      :size="16"
    />
    <details
      v-else-if="fields.size"
      class="group/parameters"
      data-testid="link-parameters"
    >
      <summary
        role="button"
        class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight :size="14" class="group-open/parameters:rotate-90" />
        {{ t("linkBuilder.parameters") }}
        <span
          v-if="selected.length"
          class="ml-auto text-xs font-normal text-muted-foreground"
          >{{ t("linkBuilder.added", { count: selected.length }) }}</span
        >
      </summary>
      <form class="mt-3 space-y-3" @submit.prevent="showPreview">
        <ComboboxRoot
          v-if="groups.length > 1"
          :model-value="plugin"
          :open="pluginOpen"
          open-on-click
          ignore-filter
          @update:model-value="plugin = String($event)"
          @update:open="
            pluginOpen = $event;
            pluginSearch = '';
          "
        >
          <ComboboxAnchor
            class="flex h-9 items-center gap-2 rounded-md border px-3 text-sm focus-within:ring-1 focus-within:ring-ring"
          >
            <ComboboxInput
              :model-value="pluginOpen ? pluginSearch : pluginLabel(plugin)"
              :display-value="pluginLabel"
              :aria-label="t('linkBuilder.plugin')"
              :placeholder="t('linkBuilder.searchPlugins')"
              autocomplete="off"
              class="min-w-0 flex-1 truncate bg-transparent outline-none"
              @update:model-value="pluginSearch = $event"
            />
            <ComboboxTrigger :aria-label="t('linkBuilder.plugin')"
              ><ChevronDown :size="14"
            /></ComboboxTrigger>
          </ComboboxAnchor>
          <ComboboxPortal>
            <ComboboxContent
              position="popper"
              align="start"
              :side-offset="4"
              class="z-50 max-h-64 w-[var(--reka-combobox-trigger-width)] overflow-y-auto rounded-md border bg-background p-1 shadow-md"
            >
              <ComboboxItem
                v-for="option in pluginOptions"
                :key="option.id"
                :value="option.id"
                class="relative flex cursor-default items-center gap-2 rounded py-2 pr-2 pl-7 text-sm outline-none data-[highlighted]:bg-muted"
              >
                <ComboboxItemIndicator class="absolute left-2"
                  ><Check :size="14"
                /></ComboboxItemIndicator>
                <span class="min-w-0 flex-1 truncate">{{ option.name }}</span>
                <span class="text-xs text-muted-foreground">{{
                  t("linkBuilder.added", { count: option.count })
                }}</span>
              </ComboboxItem>
              <p
                v-if="!pluginOptions.length"
                class="p-2 text-xs text-muted-foreground"
              >
                {{ t("linkBuilder.noPlugins") }}
              </p>
            </ComboboxContent>
          </ComboboxPortal>
        </ComboboxRoot>
        <template v-for="section in sections" :key="section.id">
          <div v-if="section.fields.length" class="space-y-3">
            <p
              v-if="plugin === 'all'"
              class="text-xs font-medium text-muted-foreground"
            >
              {{ section.name }}
            </p>
            <div
              v-for="field in section.fields"
              :key="field.key"
              class="space-y-1 border-b pb-3 last:border-0 last:pb-0"
            >
              <div class="flex items-center justify-between gap-2">
                <span
                  class="min-w-0 truncate text-xs text-muted-foreground"
                  :title="field.groups.join(' · ')"
                  >{{ field.key }}</span
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
              <p
                v-if="field.groups.length > 1"
                class="text-xs text-muted-foreground"
              >
                {{
                  t("linkBuilder.sharedWith", {
                    plugins: field.groups
                      .filter((name) => name !== section.name)
                      .join(" · "),
                  })
                }}
              </p>
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
          </div>
        </template>
        <p
          v-if="!sections.some((section) => section.fields.length)"
          class="text-xs text-muted-foreground"
        >
          {{ t("linkBuilder.noSelected") }}
        </p>
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
          <Button
            v-if="plugin !== 'all'"
            type="button"
            variant="outline"
            size="sm"
            @click="picker = true"
            ><Plus :size="16" />{{ t("linkBuilder.add") }}</Button
          >
          <Button type="submit" variant="outline" size="sm" :disabled="busy"
            ><LoaderCircle v-if="busy" class="animate-spin" :size="16" />{{
              t("ui.generatePreview")
            }}</Button
          >
          <Button
            v-if="selected.length"
            type="button"
            variant="ghost"
            size="sm"
            @click="clearParameters"
            >{{ t("linkBuilder.clear") }}</Button
          >
        </div>
      </form>
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <div v-if="preview" class="h-52 overflow-hidden rounded-lg border">
        <ImagePreview :src="preview" :contain="true" />
      </div>
    </details>
  </section>
</template>
