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
    icon: "M3 3h6l6 6-6 6-6-6Z M6 6h.01",
  },
  {
    kind: "collections" as const,
    items: props.collections,
    icon: "M2 5V3h5l2 2h7v10H2Z",
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
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="group.icon" />
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
          :title="item.name"
          :aria-label="t('organization.removeItem', { name: item.name })"
          @click="$emit('remove', group.kind, item.id)"
        >
          <svg
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="group.icon" />
          </svg>
          <span class="truncate">{{ item.name }}</span>
          <span class="text-muted-foreground" aria-hidden="true">×</span>
        </button>
      </template>
    </div>
  </div>
</template>
