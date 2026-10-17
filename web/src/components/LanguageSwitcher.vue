<script setup lang="ts">
import { locale, setLocale, t } from "@/lib/i18n";
</script>

<template>
  <select
    :value="locale"
    :aria-label="t('ui.language')"
    class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
    @change="setLocale(($event.target as HTMLSelectElement).value)"
  >
    <option value="zh-CN">简体中文</option>
    <option value="en-US">English</option>
  </select>
</template>
