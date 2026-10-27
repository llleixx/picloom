<script setup lang="ts">
import { MoreHorizontal } from "lucide-vue-next";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
} from "reka-ui";
import { Button } from "@/components/ui/button";

defineProps<{ label: string }>();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        :aria-label="label"
      >
        <MoreHorizontal />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        align="end"
        :side-offset="6"
        :collision-padding="8"
        class="z-50 min-w-40 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-1 shadow-lg"
      >
        <slot />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
