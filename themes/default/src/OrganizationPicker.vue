<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type {
  ThemeContext,
  OrganizationItem,
  OrganizationKind,
} from "@picloom/theme-sdk";
const props = defineProps<{ context: ThemeContext; kind: OrganizationKind }>();
const ctx = props.context,
  snapshot = ref(ctx.getSnapshot());
const stop = ctx.subscribe((value) => {
  snapshot.value = value;
});
onUnmounted(stop);
const search = ref(""),
  offset = ref(0),
  items = ref<OrganizationItem[]>([]),
  total = ref(0),
  known = ref(new Map<string, string>()),
  error = ref(""),
  busy = ref(false);
const selected = computed(() =>
  props.kind === "tags"
    ? snapshot.value.organization.tagIds
    : snapshot.value.organization.collectionIds,
);
let generation = 0;
async function load() {
  const request = ++generation;
  error.value = "";
  try {
    const result = await ctx.organization.list(props.kind, {
      q: search.value,
      limit: 50,
      offset: offset.value,
    });
    if (request !== generation) return;
    items.value = result.items;
    total.value = result.total;
    for (const item of items.value) known.value.set(item.id, item.name);
  } catch (e) {
    if (request === generation)
      error.value = e instanceof Error ? e.message : String(e);
  }
}
watch(search, () => {
  offset.value = 0;
});
watch([search, offset], load, { immediate: true });
function toggle(id: string) {
  const value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : selected.value.length < 100
      ? [...selected.value, id]
      : [...selected.value];
  ctx.organization.select({
    ...snapshot.value.organization,
    [props.kind === "tags" ? "tagIds" : "collectionIds"]: value,
  });
}
async function create() {
  if (!search.value.trim() || busy.value || selected.value.length >= 100)
    return;
  busy.value = true;
  error.value = "";
  try {
    const item = await ctx.organization.create(props.kind, search.value);
    known.value.set(item.id, item.name);
    if (!selected.value.includes(item.id)) toggle(item.id);
    search.value = "";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <fieldset class="organization-picker" :disabled="busy">
    <legend>
      {{
        ctx.t(
          kind === "tags" ? "organization.tags" : "organization.collections",
        )
      }}
    </legend>
    <div class="organization-chips">
      <button
        v-for="id in selected"
        :key="id"
        type="button"
        @click="toggle(id)"
      >
        {{ known.get(id) ?? id }} ×
      </button>
    </div>
    <div class="organization-search">
      <input
        v-model="search"
        :placeholder="ctx.t('organization.search')"
        :aria-label="
          ctx.t(
            kind === 'tags' ? 'organization.tags' : 'organization.collections',
          )
        "
        @keydown.enter.prevent="create"
      /><button
        type="button"
        :disabled="!search.trim() || selected.length >= 100"
        @click="create"
      >
        {{ ctx.t("organization.create") }}
      </button>
    </div>
    <div class="organization-options">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        :aria-pressed="selected.includes(item.id)"
        :disabled="!selected.includes(item.id) && selected.length >= 100"
        @click="toggle(item.id)"
      >
        {{ item.name }}
      </button>
    </div>
    <div v-if="total > 50" class="organization-search">
      <button type="button" :disabled="offset === 0" @click="offset -= 50">
        ←</button
      ><span>{{ offset + 1 }}–{{ offset + items.length }} / {{ total }}</span
      ><button
        type="button"
        :disabled="offset + 50 >= total"
        @click="offset += 50"
      >
        →
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </fieldset>
</template>
<style scoped>
.organization-picker {
  border: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 8px;
  padding: 10px;
  min-width: 0;
  font-size: 12px;
}
.organization-picker legend {
  padding: 0 4px;
  font-weight: 500;
}
.organization-chips,
.organization-search,
.organization-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.organization-search input {
  flex: 1;
  min-width: 80px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 4px;
  padding: 6px;
  background: transparent;
  color: inherit;
}
.organization-picker button {
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 4px;
  padding: 4px 7px;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}
.organization-picker button[aria-pressed="true"],
.organization-chips button {
  background: color-mix(in srgb, currentColor 12%, transparent);
}
.organization-picker button:disabled {
  opacity: 0.5;
  cursor: default;
}
.organization-options {
  max-height: 96px;
  overflow-y: auto;
}
.organization-picker p {
  margin-top: 6px;
}
</style>
