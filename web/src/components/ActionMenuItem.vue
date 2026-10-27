<script setup lang="ts">
import { useId } from "vue";
import { DropdownMenuItem, DropdownMenuSeparator } from "reka-ui";

defineProps<{
  disabled?: boolean;
  destructive?: boolean;
  separator?: boolean;
  description?: string;
}>();
defineEmits<{ select: [event: Event] }>();
const id = useId();
</script>

<template>
  <DropdownMenuSeparator v-if="separator" class="my-1 border-t" />
  <DropdownMenuItem
    :disabled="disabled"
    :aria-labelledby="id"
    :aria-describedby="description ? id + '-description' : undefined"
    class="flex cursor-default flex-col items-start gap-1 rounded px-2 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
    :class="
      destructive
        ? 'text-destructive data-[highlighted]:bg-destructive/10'
        : 'data-[highlighted]:bg-muted'
    "
    @select="$emit('select', $event)"
  >
    <span :id="id"><slot /></span>
    <span
      v-if="description"
      :id="id + '-description'"
      class="max-w-64 text-xs text-muted-foreground"
      >{{ description }}</span
    >
  </DropdownMenuItem>
</template>
