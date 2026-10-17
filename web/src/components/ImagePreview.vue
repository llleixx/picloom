<script setup lang="ts">
import { t } from "@/lib/i18n";
import { ref, watch } from "vue";
import { ImageOff, RotateCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
const props = defineProps<{ src: string; alt?: string; contain?: boolean }>();
const failed = ref(false),
  attempt = ref(0);
watch(
  () => props.src,
  () => {
    failed.value = false;
    attempt.value = 0;
  },
);
</script>
<template>
  <div
    class="checker flex h-full min-h-24 w-full items-center justify-center overflow-hidden"
  >
    <div
      v-if="failed"
      class="flex flex-col items-center gap-2 p-4 text-muted-foreground"
    >
      <ImageOff :size="24" /><span class="text-xs">{{
        t("ui.imageFailedToLoad")
      }}</span
      ><Button
        variant="ghost"
        size="sm"
        @click.stop="
          failed = false;
          attempt++;
        "
        ><RotateCw :size="14" />{{ t("ui.retry") }}</Button
      >
    </div>
    <img
      v-else
      :key="`${src}:${attempt}`"
      :src="src"
      :alt="alt ?? t('ui.imagePreview')"
      loading="lazy"
      decoding="async"
      class="h-full w-full"
      :class="contain ? 'object-contain' : 'object-cover'"
      @error="failed = true"
    />
  </div>
</template>
