<script setup lang="ts">
import { t } from "@/lib/i18n";
import { useMenuDialogFocus } from "@/lib/dialog-focus";
import type { DialogContentEmits, DialogContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { X } from "lucide-vue-next";
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<
  DialogContentProps & { class?: HTMLAttributes["class"]; busy?: boolean }
>();
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "busy");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
const rememberMenuTrigger = useMenuDialogFocus();
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      class="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <DialogContent
      @open-auto-focus="rememberMenuTrigger"
      @escape-key-down="
        (event) => {
          if (busy) event.preventDefault();
        }
      "
      @interact-outside="
        (event) => {
          if (busy) event.preventDefault();
        }
      "
      v-bind="forwarded"
      :class="
        cn(
          'fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          props.class,
        )
      "
    >
      <slot />

      <DialogClose
        :disabled="busy"
        :aria-label="t('ui.close')"
        class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
      >
        <X class="w-4 h-4" />
        <span class="sr-only">{{ t("ui.close") }}</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
