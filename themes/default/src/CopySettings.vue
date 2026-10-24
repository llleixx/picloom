<script setup lang="ts">
import { ref } from "vue";
import UploadPopover from "./UploadPopover.vue";
const props = defineProps<{
  format: string;
  formats: readonly string[];
  auto: boolean;
  t: (key: "uploads.copyFormat" | "ui.copy" | "uploads.autoCopy") => string;
}>();
const emit = defineEmits<{
  change: [format: string, auto: boolean];
}>();
const popover = ref<InstanceType<typeof UploadPopover>>();
function choose(format: string) {
  emit("change", format, props.auto);
  popover.value?.close();
}
</script>
<template>
  <UploadPopover
    ref="popover"
    :label="`${t('uploads.copyFormat')}: ${format}`"
    align="end"
  >
    <template #trigger>
      {{ t("ui.copy") }}: {{ format }}
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path d="m4 6 4 4 4-4" />
      </svg>
    </template>
    <div class="space-y-1" role="group" :aria-label="t('uploads.copyFormat')">
      <button
        v-for="value in formats"
        :key="value"
        type="button"
        class="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted"
        :class="value === format && 'bg-muted text-primary'"
        :aria-pressed="value === format"
        @click="choose(value)"
      >
        <span class="size-4 shrink-0" aria-hidden="true">
          <svg
            v-if="value === format"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="m3 8 3 3 7-7" />
          </svg>
        </span>
        {{ value }}
      </button>
    </div>
    <label class="mt-2 flex items-center gap-2 border-t px-2 pt-3 pb-1 text-sm">
      <input
        type="checkbox"
        :checked="auto"
        @change="
          $emit('change', format, ($event.target as HTMLInputElement).checked)
        "
      />
      {{ t("uploads.autoCopy") }}
    </label>
  </UploadPopover>
</template>
