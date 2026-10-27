<script setup lang="ts">
import { LoaderCircle } from "lucide-vue-next";
import { t } from "@/lib/i18n";
import type { PackageUploadState } from "@/lib/package-upload";

defineProps<{ state: PackageUploadState }>();
</script>

<template>
  <div class="rounded-lg border p-3 text-sm">
    <p class="truncate font-medium" :title="state.name">{{ state.name }}</p>
    <p role="status" class="mt-1 flex items-center gap-2 text-muted-foreground">
      <LoaderCircle class="size-4 shrink-0 animate-spin" aria-hidden="true" />
      {{
        state.inspecting
          ? t("ui.inspectingPackage")
          : state.progress === null
            ? t("ui.uploadingPackage")
            : t("uploads.progress", { progress: state.progress })
      }}
    </p>
    <progress
      v-if="!state.inspecting"
      :value="state.progress ?? undefined"
      max="100"
      class="mt-2 h-1 w-full accent-primary"
      :aria-label="t('ui.uploadProgress')"
    />
  </div>
</template>
