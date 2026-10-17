<script setup lang="ts">
import { t } from "@/lib/i18n";
const whole = defineModel<boolean>("whole", { required: true });
const includeLast = defineModel<boolean>("includeLast", { required: true });
</script>
<template>
  <div class="space-y-3">
    <label class="block space-y-2"
      ><span>{{ t("replicas.scope") }}</span>
      <select v-model="whole" class="native-select w-full">
        <option :value="false">{{ t("replicas.onlySource") }}</option>
        <option :value="true">{{ t("replicas.wholeImage") }}</option>
      </select>
    </label>
    <template v-if="!whole">
      <p class="subtle">{{ t("replicas.keepLast") }}</p>
      <label class="flex items-start gap-2 text-sm"
        ><input v-model="includeLast" type="checkbox" class="mt-1" />{{
          t("replicas.includeLast")
        }}</label
      >
    </template>
  </div>
</template>
