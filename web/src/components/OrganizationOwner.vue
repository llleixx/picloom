<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Check, ChevronDown } from "lucide-vue-next";
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
import { api, errorText, isAdmin, session } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { UserView } from "../../../shared/api";
const props = defineProps<{
  mineLabel: string;
  allLabel?: string;
  includeGuest?: boolean;
  ariaLabel?: string;
}>();
const model = defineModel<string>({ required: true });
const search = ref(""),
  open = ref(false);
const names = ref(new Map<string, string>());
const users = useQuery({
  queryKey: computed(() => ["users", "organization", search.value]),
  enabled: isAdmin,
  queryFn: ({ signal }) =>
    api<{ items: UserView[] }>(
      "/api/users?limit=30&q=" + encodeURIComponent(search.value),
      { signal },
    ),
});
watch(
  users.data,
  (value) => {
    for (const user of value?.items ?? [])
      names.value.set(user.id, user.username);
  },
  { immediate: true },
);
const options = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const shortcuts = [
    { id: "me", name: props.mineLabel },
    ...(props.allLabel ? [{ id: "all", name: props.allLabel }] : []),
    ...(props.includeGuest ? [{ id: "guest", name: t("users.guest") }] : []),
  ].filter((item) => !query || item.name.toLocaleLowerCase().includes(query));
  return [
    ...shortcuts,
    ...(users.data.value?.items ?? [])
      .filter((user) => user.id !== session.value?.user.id)
      .map((user) => ({ id: user.id, name: user.username })),
  ];
});
function label(value: unknown) {
  if (value === "all" && props.allLabel) return props.allLabel;
  if (value === "guest" && props.includeGuest) return t("users.guest");
  return value === "me" || value === session.value?.user.id
    ? props.mineLabel
    : (names.value.get(String(value)) ?? String(value));
}
function setOpen(value: boolean) {
  open.value = value;
  if (value) search.value = "";
}
</script>
<template>
  <ComboboxRoot
    v-if="isAdmin"
    :model-value="model"
    :open="open"
    open-on-click
    ignore-filter
    class="w-24 min-w-0 sm:w-36"
    @update:open="setOpen"
    @update:model-value="model = String($event)"
  >
    <ComboboxAnchor
      class="flex h-8 items-center gap-1 rounded-md bg-muted/50 px-2 text-xs focus-within:ring-1 focus-within:ring-ring"
    >
      <ComboboxInput
        :model-value="open ? search : label(model)"
        :display-value="label"
        :aria-label="ariaLabel ?? t('users.owner')"
        :placeholder="t('users.search')"
        autocomplete="off"
        class="min-w-0 flex-1 truncate bg-transparent outline-none"
        @update:model-value="search = $event"
      />
      <ComboboxTrigger
        :aria-label="ariaLabel ?? t('users.owner')"
        class="shrink-0"
      >
        <ChevronDown :size="14" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        align="start"
        :side-offset="6"
        class="z-50 max-h-[min(15rem,var(--reka-combobox-content-available-height))] w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-background p-1 shadow-lg"
      >
        <ComboboxItem
          v-for="user in options"
          :key="user.id"
          :value="user.id"
          class="relative cursor-default rounded py-2 pr-3 pl-7 text-sm outline-none data-[highlighted]:bg-muted"
        >
          <ComboboxItemIndicator class="absolute left-2">
            <Check :size="14" />
          </ComboboxItemIndicator>
          <span class="block truncate">{{ user.name }}</span>
        </ComboboxItem>
        <p
          v-if="users.isPending.value"
          class="px-2 py-2 text-xs text-muted-foreground"
        >
          {{ t("ui.loading") }}
        </p>
        <p
          v-else-if="users.error.value"
          role="alert"
          class="px-2 py-2 text-xs text-destructive"
        >
          {{ errorText(users.error.value) }}
        </p>
        <p
          v-else-if="!options.length"
          class="px-2 py-2 text-xs text-muted-foreground"
        >
          {{ t("users.empty") }}
        </p>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
