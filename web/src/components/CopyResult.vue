<script setup lang="ts">
import { computed } from "vue";
import { Copy } from "lucide-vue-next";
import { t } from "@/lib/i18n";
import { copy } from "@/lib/api";
import { copyFormats, copyPreferences, formatLink } from "@/lib/link-formats";
import { Button } from "@/components/ui/button";
const props = defineProps<{ url: string; label: string }>();
const value = computed(() => formatLink(props.url, copyPreferences.format));
</script>
<template>
  <div class="space-y-2" role="group" :aria-label="t('ui.copy')">
    <div class="flex items-center gap-2">
      <select
        v-model="copyPreferences.format"
        :aria-label="t('uploads.copyFormat')"
        class="native-select flex-1"
      >
        <option v-for="format in copyFormats" :key="format" :value="format">
          {{ format }}
        </option>
      </select>
      <Button type="button" variant="outline" @click="copy(value)"
        ><Copy />{{ t("ui.copy") }}</Button
      >
    </div>
    <textarea
      :aria-label="label"
      readonly
      rows="2"
      :value="value"
      class="native-select h-auto w-full resize-y py-2 text-xs"
    />
  </div>
</template>
