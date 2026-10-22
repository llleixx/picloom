<script setup lang="ts">
import { t } from "@/lib/i18n";
import { loadThumbnail } from "@/lib/thumbnails";
import { useIntersectionObserver } from "@vueuse/core";
import { ref, watch } from "vue";
import { ImageOff, RotateCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
const props = defineProps<{
  src: string;
  alt?: string;
  contain?: boolean;
  thumbnail?: boolean;
}>();
const failed = ref(false),
  attempt = ref(0);
const container = ref<HTMLElement>(),
  visible = ref(false),
  thumbnailUrl = ref("");
const { stop } = useIntersectionObserver(
  container,
  ([entry]) => {
    if (entry?.isIntersecting) {
      visible.value = true;
      stop();
    }
  },
  { rootMargin: "300px" },
);
watch(
  () => props.src,
  () => {
    failed.value = false;
    attempt.value = 0;
  },
);
watch(
  [() => props.thumbnail, visible, () => props.src, attempt],
  ([thumbnail, isVisible, src], _, onCleanup) => {
    if (!thumbnail || !isVisible) return;
    const controller = new AbortController();
    let url = "";
    thumbnailUrl.value = "";
    failed.value = false;
    onCleanup(() => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    });
    void loadThumbnail(src, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        thumbnailUrl.value = url;
      })
      .catch(() => {
        if (!controller.signal.aborted) failed.value = true;
      });
  },
  { immediate: true },
);
</script>
<template>
  <div
    ref="container"
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
      v-else-if="!thumbnail || thumbnailUrl"
      :key="`${src}:${attempt}`"
      :src="thumbnail ? thumbnailUrl : src"
      :alt="alt ?? t('ui.imagePreview')"
      loading="lazy"
      decoding="async"
      class="h-full w-full"
      :class="contain ? 'object-contain' : 'object-cover'"
      @error="failed = true"
    />
  </div>
</template>
