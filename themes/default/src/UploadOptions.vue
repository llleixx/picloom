<script setup lang="ts">
import { computed } from "vue";
import UploadPopover from "./UploadPopover.vue";
type Item = { id: string; name: string };
const props = defineProps<{
  tags: readonly Item[];
  collections: readonly Item[];
  signedIn: boolean;
  initialKind?: "tags" | "collections";
  t: (
    key:
      | "organization.addTags"
      | "organization.addCollections"
      | "organization.removeItem",
    params?: Record<string, string | number>,
  ) => string;
}>();
defineEmits<{ remove: [kind: "tags" | "collections", id: string] }>();
const groups = computed(() => [
  {
    kind: "tags" as const,
    items: props.tags,
    icon: "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
  },
  {
    kind: "collections" as const,
    items: props.collections,
    icon: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  },
]);
</script>
<template>
  <div class="space-y-2.5">
    <div class="relative flex min-w-0 flex-wrap items-center gap-1.5">
      <div v-if="$slots.profile" class="flex min-w-0 max-w-full">
        <slot name="profile" />
      </div>
      <template v-if="signedIn">
        <UploadPopover
          v-for="group in groups"
          :key="group.kind"
          :open="group.kind === initialKind"
          :label="
            t(
              group.kind === 'tags'
                ? 'organization.addTags'
                : 'organization.addCollections',
            )
          "
        >
          <template #trigger>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="group.icon" />
              <circle
                v-if="group.kind === 'tags'"
                cx="7.5"
                cy="7.5"
                r=".5"
                fill="currentColor"
              />
            </svg>
            {{
              t(
                group.kind === "tags"
                  ? "organization.addTags"
                  : "organization.addCollections",
              )
            }}
            <span aria-hidden="true">+</span>
          </template>
          <slot :name="group.kind" />
        </UploadPopover>
      </template>
    </div>
    <div
      v-if="signedIn && (tags.length || collections.length)"
      class="flex min-w-0 flex-wrap gap-1.5"
    >
      <template v-for="group in groups" :key="group.kind">
        <button
          v-for="item in group.items"
          :key="item.id"
          type="button"
          class="upload-chip"
          :class="{ 'upload-chip-collection': group.kind === 'collections' }"
          :title="item.name"
          :aria-label="t('organization.removeItem', { name: item.name })"
          @click="$emit('remove', group.kind, item.id)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="group.icon" />
            <circle
              v-if="group.kind === 'tags'"
              cx="7.5"
              cy="7.5"
              r=".5"
              fill="currentColor"
            />
          </svg>
          <span class="truncate">{{ item.name }}</span>
          <span class="text-muted-foreground" aria-hidden="true">×</span>
        </button>
      </template>
    </div>
  </div>
</template>
