<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
defineProps<{ label: string; align?: "end" }>();
const root = ref<HTMLDetailsElement>();
function dismiss() {
  if (!root.value) return;
  root.value.open = false;
  root.value.querySelector("summary")?.focus();
}
defineExpose({ close: dismiss });
function close(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node))
    root.value?.removeAttribute("open");
}
function escape(event: KeyboardEvent) {
  if (event.key !== "Escape" || !root.value?.open) return;
  event.preventDefault();
  event.stopPropagation();
  dismiss();
}
function reveal() {
  if (root.value?.open)
    root.value
      .querySelector(".upload-popover-content")
      ?.scrollIntoView({ block: "nearest" });
}
function focusOut(event: FocusEvent) {
  if (event.relatedTarget && !root.value?.contains(event.relatedTarget as Node))
    root.value?.removeAttribute("open");
}
onMounted(() => {
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", escape, true);
});
onUnmounted(() => {
  document.removeEventListener("pointerdown", close);
  document.removeEventListener("keydown", escape, true);
});
</script>
<template>
  <details
    ref="root"
    name="upload-settings"
    class="upload-popover"
    :class="{ 'upload-popover-end': align === 'end' }"
    @toggle="reveal"
    @focusout="focusOut"
  >
    <summary role="button" :aria-label="label" class="upload-control">
      <slot name="trigger" />
    </summary>
    <div class="upload-popover-content" role="group" :aria-label="label">
      <slot />
    </div>
  </details>
</template>
<style scoped>
.upload-popover summary {
  list-style: none;
}
.upload-popover summary::-webkit-details-marker {
  display: none;
}
.upload-popover-content {
  position: absolute;
  z-index: 20;
  top: calc(100% + 0.5rem);
  left: 0;
  width: min(22rem, 100%);
  max-height: calc(100dvh - 4rem);
  overflow-y: auto;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.75rem;
  background: var(--background);
  color: var(--foreground);
  box-shadow: 0 8px 24px #00000012;
  text-align: left;
}
.upload-popover-end {
  position: relative;
}
.upload-popover-end .upload-popover-content {
  right: 0;
  left: auto;
  width: min(17rem, calc(100vw - 4rem));
}
</style>
