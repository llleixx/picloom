<script setup lang="ts">
import { ref, watch } from "vue";
import defaultIcon from "@/assets/picloom.svg?no-inline";
import { useSite } from "@/lib/site";
const { name, logoUrl } = useSite();
const failed = ref(false);
watch(logoUrl, () => (failed.value = false));
</script>
<template>
  <span class="inline-flex min-w-0 items-center gap-2">
    <img
      :src="failed ? defaultIcon : logoUrl"
      alt=""
      class="size-8 shrink-0 object-contain"
      @error="failed = true"
    />
    <span class="break-words">{{ name }}</span>
  </span>
</template>
