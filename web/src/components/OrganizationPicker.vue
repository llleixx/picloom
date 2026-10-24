<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, response, errorText, queryClient } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { OrganizationItem, TagView } from "../../../shared/organization";
const props = withDefaults(
  defineProps<{
    kind: "tags" | "collections";
    owner?: string;
    disabled?: boolean;
    create?: boolean;
    max?: number;
    items?: readonly OrganizationItem[];
  }>(),
  { create: true, max: 100 },
);
const model = defineModel<string[]>({ required: true });
const search = ref(""),
  offset = ref(0),
  busy = ref(false),
  error = ref("");
const known = ref(new Map<string, OrganizationItem>());
watch(
  () => props.items,
  (items) => {
    for (const item of items ?? []) known.value.set(item.id, item);
  },
  { immediate: true },
);
watch(
  () => [props.owner, props.kind],
  () => {
    search.value = "";
    offset.value = 0;
    known.value.clear();
  },
);
watch(search, () => (offset.value = 0));
const list = useQuery({
  queryKey: computed(() => [
    "organization",
    props.kind,
    props.owner,
    search.value,
    offset.value,
  ]),
  queryFn: async ({ signal }) => {
    const p = new URLSearchParams({
      q: search.value,
      limit: "50",
      offset: String(offset.value),
    });
    if (props.owner !== undefined) p.set("owner", props.owner);
    const res = await response(`/api/${props.kind}?${p}`, { signal });
    return {
      items: (await res.json()) as TagView[],
      total: Number(res.headers.get("X-Total-Count") ?? 0),
    };
  },
});
watch(
  list.data,
  (value) => {
    for (const item of value?.items ?? []) known.value.set(item.id, item);
  },
  { immediate: true },
);
function toggle(id: string) {
  if (model.value.includes(id))
    model.value = model.value.filter((value) => value !== id);
  else if (props.max === 1) model.value = [id];
  else if (model.value.length < props.max) model.value = [...model.value, id];
}
async function create() {
  if (!search.value.trim() || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const item = await api<TagView>(`/api/${props.kind}`, {
      method: "POST",
      body: JSON.stringify({
        name: search.value,
        ...(props.owner !== undefined ? { ownerId: props.owner } : {}),
      }),
    });
    known.value.set(item.id, item);
    if (!model.value.includes(item.id)) toggle(item.id);
    search.value = "";
    await queryClient.invalidateQueries({
      queryKey: ["organization", props.kind],
    });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <fieldset
    :disabled="disabled || busy"
    class="min-w-0 space-y-2 rounded-lg border p-3"
  >
    <legend class="px-1 text-sm font-medium">
      {{
        t(kind === "tags" ? "organization.tags" : "organization.collections")
      }}
    </legend>
    <div v-if="model.length" class="flex flex-wrap gap-1">
      <button
        v-for="id in model"
        :key="id"
        type="button"
        class="max-w-full rounded bg-muted px-2 py-1 text-xs break-all"
        @click="toggle(id)"
        :aria-label="
          t('organization.removeItem', { name: known.get(id)?.name ?? id })
        "
      >
        {{ known.get(id)?.name ?? id }} ×
      </button>
    </div>
    <div class="flex gap-2">
      <Input
        v-model="search"
        :placeholder="t('organization.search')"
        :aria-label="
          t(
            kind === 'tags'
              ? 'organization.searchTags'
              : 'organization.searchCollections',
          )
        "
        class="min-w-0"
        @keydown.enter.prevent="props.create && create()"
      /><Button
        v-if="props.create"
        type="button"
        variant="outline"
        size="sm"
        :disabled="!search.trim() || (max !== 1 && model.length >= max)"
        @click="create"
        >{{ t("ui.create") }}</Button
      >
    </div>
    <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
      <button
        v-for="item in list.data.value?.items"
        :key="item.id"
        type="button"
        class="rounded border px-2 py-1 text-xs text-left break-all"
        :class="
          model.includes(item.id) && 'border-primary bg-primary/10 text-primary'
        "
        :aria-pressed="model.includes(item.id)"
        :disabled="!model.includes(item.id) && max !== 1 && model.length >= max"
        @click="toggle(item.id)"
      >
        {{ item.name }}
      </button>
    </div>
    <p v-if="list.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
    <p
      v-else-if="!list.data.value?.items.length && !list.error.value"
      class="subtle"
    >
      {{ t("organization.empty") }}
    </p>
    <div
      v-if="(list.data.value?.total ?? 0) > 50"
      class="flex items-center gap-2"
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        :disabled="offset === 0"
        @click="offset -= 50"
        >{{ t("organization.previous") }}</Button
      ><span class="subtle"
        >{{ offset + 1 }}–{{ offset + (list.data.value?.items.length ?? 0) }} /
        {{ list.data.value?.total }}</span
      ><Button
        type="button"
        size="sm"
        variant="ghost"
        :disabled="offset + 50 >= (list.data.value?.total ?? 0)"
        @click="offset += 50"
        >{{ t("organization.next") }}</Button
      >
    </div>
    <p v-if="error || list.error.value" class="error-box" role="alert">
      {{ error || errorText(list.error.value) }}
    </p>
  </fieldset>
</template>
