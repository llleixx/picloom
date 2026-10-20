<script setup lang="ts">
import { locale, availableLocales, setLocale, t } from "@/lib/i18n";
import { languages } from "../../../shared/locales";
</script>

<template>
  <select
    v-if="availableLocales.length > 1"
    :value="locale"
    :aria-label="t('ui.language')"
    class="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
    @change="setLocale(($event.target as HTMLSelectElement).value)"
  >
    <option
      v-for="language in languages.filter((item) =>
        availableLocales.includes(item.tag),
      )"
      :key="language.tag"
      :value="language.tag"
    >
      {{ language.name }}
    </option>
  </select>
</template>
