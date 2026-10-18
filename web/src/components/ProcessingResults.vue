<script setup lang="ts">
import type { ProcessingResult } from "../../../shared/api";
import { t } from "@/lib/i18n";
import { date } from "@/lib/utils";
defineProps<{ results: ProcessingResult[] }>();
const complex = (value: unknown) => value !== null && typeof value === "object";
</script>
<template>
  <section v-if="results.length" class="mt-6 space-y-4 border-t pt-5">
    <h3 class="font-medium">{{ t("processingResults.title") }}</h3>
    <p class="subtle">{{ t("processingResults.hint") }}</p>
    <div
      v-for="result in results"
      :key="result.stepId"
      class="space-y-2 text-sm"
    >
      <p class="break-all font-medium">
        {{ result.pluginId }} · {{ result.pluginVersion }}
      </p>
      <p class="subtle">
        {{ date(result.completedAt) }} ·
        {{ t(`processingResults.${result.status}`) }}
      </p>
      <p v-if="result.overrideStatus" class="subtle">
        {{ t("processingResults.override") }} ·
        {{ t(`processingResults.${result.overrideStatus}`) }}
      </p>
      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2">
        <template v-for="(value, key) in result.details" :key="key">
          <dt class="break-all text-muted-foreground">{{ key }}</dt>
          <dd class="min-w-0 break-words">
            <details v-if="complex(value)">
              <summary class="cursor-pointer">
                {{ t("processingResults.details") }}
              </summary>
              <pre class="mt-2 whitespace-pre-wrap break-all text-xs">{{
                JSON.stringify(value, null, 2)
              }}</pre>
            </details>
            <span v-else>{{ value === null ? "—" : String(value) }}</span>
          </dd>
        </template>
      </dl>
    </div>
  </section>
</template>
