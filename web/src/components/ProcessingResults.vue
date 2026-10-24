<script setup lang="ts">
import type { ProcessingResult } from "../../../shared/api";
import { t } from "@/lib/i18n";
import { date } from "@/lib/utils";
defineProps<{ results: ProcessingResult[] }>();
const complex = (value: unknown) => value !== null && typeof value === "object";
</script>
<template>
  <details v-if="results.length" class="space-y-3">
    <summary role="button" class="cursor-pointer text-sm font-medium">
      {{ t("processingResults.title") }}
    </summary>
    <p class="text-xs text-muted-foreground">
      {{ t("processingResults.hint") }}
    </p>
    <div
      v-for="result in results"
      :key="result.stepId"
      class="space-y-2 text-sm"
    >
      <p class="break-all font-medium">
        {{ result.pluginId }} · {{ result.pluginVersion }}
      </p>
      <p class="subtle">
        {{ date(result.completedAt)
        }}<template v-if="result.disposition">
          · {{ t(`processingResults.${result.disposition.value}`) }}</template
        >
      </p>
      <p v-if="result.disposition?.mode === 'replace'" class="subtle">
        {{ t("processingResults.override") }} ·
        {{
          result.disposition
            ? t(`processingResults.${result.disposition.value}`)
            : ""
        }}
      </p>
      <details v-if="result.organization" class="subtle">
        <summary class="cursor-pointer">{{ t("organization.title") }}</summary>
        <pre class="mt-2 whitespace-pre-wrap break-all text-xs">{{
          JSON.stringify(result.organization, null, 2)
        }}</pre>
      </details>
      <dl
        class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[6rem_minmax(0,1fr)]"
      >
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
  </details>
</template>
