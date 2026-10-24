<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import { SlidersHorizontal, X } from "lucide-vue-next";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
defineProps<{ count: number }>();
defineEmits<{ reset: [] }>();
const mobile = useMediaQuery("(max-width: 639px)");
const trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLDialogElement>();
const open = ref(false),
  position = ref({ top: "0px", left: "0px", maxHeight: "80dvh" });
let previousOverflow: string | undefined;
function show() {
  if (!panel.value || !trigger.value) return;
  if (mobile.value) {
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    panel.value.showModal();
  } else {
    const rect = trigger.value.getBoundingClientRect();
    const top = Math.min(rect.bottom + 8, Math.max(16, innerHeight - 320));
    position.value = {
      top: `${top}px`,
      left: `${Math.max(16, Math.min(rect.right - 416, innerWidth - 432))}px`,
      maxHeight: `${Math.max(160, innerHeight - top - 16)}px`,
    };
    panel.value.show();
  }
  open.value = true;
}
function close() {
  if (!open.value) return;
  panel.value?.close();
  if (previousOverflow !== undefined) {
    document.documentElement.style.overflow = previousOverflow;
    previousOverflow = undefined;
  }
  open.value = false;
  trigger.value?.focus();
}
function outside(event: PointerEvent) {
  if (!open.value || trigger.value?.contains(event.target as Node)) return;
  const rect = panel.value?.getBoundingClientRect();
  if (
    !panel.value?.contains(event.target as Node) ||
    (rect &&
      event.target === panel.value &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom))
  )
    close();
}
function escape(event: KeyboardEvent) {
  if (event.defaultPrevented || event.key !== "Escape" || !open.value) return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
function resize() {
  if (!mobile.value) close();
}
watch(mobile, close);
onMounted(() => {
  document.addEventListener("pointerdown", outside);
  document.addEventListener("keydown", escape);
  window.addEventListener("resize", resize);
});
onUnmounted(() => {
  if (previousOverflow !== undefined)
    document.documentElement.style.overflow = previousOverflow;
  document.removeEventListener("pointerdown", outside);
  document.removeEventListener("keydown", escape);
  window.removeEventListener("resize", resize);
});
</script>
<template>
  <button
    ref="trigger"
    type="button"
    class="native-select order-1 inline-flex shrink-0 items-center gap-1.5 shadow-none sm:order-2"
    :aria-label="t('organization.filters')"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="open ? close() : show()"
  >
    <SlidersHorizontal :size="15" /><span>{{ t("images.filters") }}</span>
    <span
      v-if="count"
      class="rounded bg-primary/10 px-1.5 text-xs text-primary"
      >{{ count }}</span
    >
  </button>
  <dialog
    ref="panel"
    :style="mobile ? undefined : position"
    class="image-filters"
    :aria-label="t('organization.filters')"
    @cancel.prevent="close"
  >
    <div
      class="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3"
    >
      <h2 class="text-sm font-medium">{{ t("organization.filters") }}</h2>
      <div class="flex items-center gap-2">
        <Button
          v-if="count"
          size="sm"
          variant="ghost"
          @click="$emit('reset')"
          >{{ t("images.resetFilters") }}</Button
        >
        <Button
          size="icon-sm"
          variant="ghost"
          :aria-label="t('ui.close')"
          @click="close"
          ><X
        /></Button>
      </div>
    </div>
    <div class="min-h-0 space-y-4 overflow-y-auto p-4"><slot /></div>
    <div class="flex shrink-0 justify-end border-t px-4 py-3">
      <Button size="sm" @click="close">{{ t("images.done") }}</Button>
    </div>
  </dialog>
</template>
<style scoped>
.image-filters {
  position: fixed;
  z-index: 40;
  width: 26rem;
  max-width: calc(100vw - 2rem);
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 12px 40px #00000018;
}
.image-filters[open] {
  display: flex;
  flex-direction: column;
}
.image-filters::backdrop {
  background: #0008;
}
@media (max-width: 639px) {
  .image-filters {
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    max-height: 85dvh;
    border-radius: 1rem 1rem 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
}
</style>
