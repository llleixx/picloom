<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import StatisticsPanel from "@/components/StatisticsPanel.vue";
import BackupPanel from "@/components/BackupPanel.vue";
import { useQuery } from "@tanstack/vue-query";
import type { SystemStatus } from "../../../shared/api";
import { api, errorText, errorMessage, notify } from "@/lib/api";
import { t } from "@/lib/i18n";
import { date, size } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
const route = useRoute();
const router = useRouter();
const tab = computed(() =>
  route.query.view === "system" ? "system" : "statistics",
);
function selectTab(view: string) {
  router.replace({
    query: { ...route.query, view: view === "system" ? view : undefined },
  });
}
const query = useQuery({
  queryKey: ["system-status"],
  queryFn: () => api<SystemStatus>("/api/system/status"),
  staleTime: 0,
  refetchInterval: (q) => (q.state.data?.local.calculating ? 1500 : 60000),
});
const confirmClear = ref(false),
  clearing = ref(false),
  clearError = ref("");
async function clearCache() {
  if (clearing.value) return;
  clearing.value = true;
  clearError.value = "";
  try {
    await api("/api/system/cache/clear", { method: "POST" });
    confirmClear.value = false;
    notify({ key: "system.cacheCleared" });
    await query.refetch();
  } catch (e) {
    clearError.value = errorText(e);
  } finally {
    clearing.value = false;
  }
}
const status = computed(() => query.data.value);
const diskUsed = computed(() => {
  const local = status.value?.local;
  return local?.diskTotal != null && local.diskAvailable != null
    ? Math.max(0, local.diskTotal - local.diskAvailable)
    : null;
});
const uptime = computed(() => {
  const seconds = status.value?.uptimeSeconds ?? 0;
  return t("system.duration", {
    days: Math.floor(seconds / 86400),
    hours: Math.floor(seconds / 3600) % 24,
    minutes: Math.floor(seconds / 60) % 60,
  });
});
const usage = (value: number | null) =>
  value === null
    ? t(
        status.value?.local.measuredAt === null &&
          status.value?.local.calculating
          ? "system.calculating"
          : "system.unavailable",
      )
    : size(value);
const kinds = computed(() => ({
  write: t("system.write"),
  action: t("system.action"),
  delete: t("system.delete"),
}));
</script>
<template>
  <div class="max-w-6xl">
    <header class="page-header">
      <h1 class="page-heading">{{ t("system.title") }}</h1>
    </header>
    <div
      class="mb-6 flex gap-1 border-b pb-3"
      role="tablist"
      :aria-label="t('system.title')"
    >
      <Button
        id="statistics-tab"
        role="tab"
        aria-controls="statistics-panel"
        :aria-selected="tab === 'statistics'"
        :variant="tab === 'statistics' ? 'secondary' : 'ghost'"
        @click="selectTab('statistics')"
        >{{ t("statistics.title") }}</Button
      >
      <Button
        id="maintenance-tab"
        role="tab"
        aria-controls="maintenance-panel"
        :aria-selected="tab === 'system'"
        :variant="tab === 'system' ? 'secondary' : 'ghost'"
        @click="selectTab('system')"
        >{{ t("system.maintenance") }}</Button
      >
    </div>
    <div
      v-if="tab === 'statistics'"
      id="statistics-panel"
      role="tabpanel"
      aria-labelledby="statistics-tab"
    >
      <StatisticsPanel />
    </div>
    <div
      v-if="tab === 'system'"
      id="maintenance-panel"
      role="tabpanel"
      aria-labelledby="maintenance-tab"
      class="max-w-4xl"
    >
      <p v-if="query.isPending.value" class="subtle mt-6">
        {{ t("ui.loading") }}
      </p>
      <div v-if="query.isError.value" class="mt-6 space-y-3">
        <p role="alert" class="error-box">{{ errorText(query.error.value) }}</p>
        <Button variant="outline" @click="query.refetch()">{{
          t("ui.retry")
        }}</Button>
      </div>
      <div v-if="status" class="mt-7 space-y-8">
        <p class="subtle" data-testid="service-uptime">
          {{ t("system.uptime") }} · {{ uptime }}
        </p>
        <section class="border-t pt-6">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="section-heading">{{ t("system.local") }}</h2>
            <Button
              variant="outline"
              size="sm"
              @click="
                clearError = '';
                confirmClear = true;
              "
              >{{ t("system.clearCache") }}</Button
            >
          </div>
          <div class="mt-5">
            <div
              class="flex flex-wrap justify-between gap-3 text-sm tabular-nums"
            >
              <span>{{ t("system.diskUsed") }}: {{ usage(diskUsed) }}</span>
              <span
                >{{ t("system.diskAvailable") }}:
                {{ usage(status.local.diskAvailable) }}</span
              >
            </div>
            <div
              v-if="diskUsed !== null && status.local.diskTotal"
              class="mt-3 h-2 overflow-hidden rounded-full bg-muted"
              role="img"
              :aria-label="
                t('system.diskUsage', {
                  used: size(diskUsed),
                  available: size(status.local.diskAvailable),
                })
              "
            >
              <div
                class="h-full rounded-full bg-primary/70"
                :style="{
                  width: `${(diskUsed / status.local.diskTotal) * 100}%`,
                }"
              />
            </div>
            <p class="subtle mt-2">
              {{ t("system.diskTotal") }}:
              <span data-testid="usage-diskTotal">{{
                usage(status.local.diskTotal)
              }}</span>
            </p>
          </div>
          <dl class="mt-5 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <div
              v-for="item in [
                ['originals', 'system.originals'],
                ['temporary', 'system.temp'],
                ['cache', 'system.cache'],
              ] as const"
              :key="item[0]"
            >
              <dt class="subtle">{{ t(item[1]) }}</dt>
              <dd
                class="mt-2 text-lg font-medium tabular-nums"
                :data-testid="'usage-' + item[0]"
              >
                {{ usage(status.local[item[0]]) }}
              </dd>
            </div>
          </dl>
          <p class="subtle mt-3" role="status">
            {{
              status.local.calculating
                ? t("system.calculating")
                : status.local.measuredAt
                  ? t("system.measured", {
                      time: date(status.local.measuredAt),
                    })
                  : t("system.unavailable")
            }}
          </p>
        </section>
        <section class="border-t pt-6">
          <h2 class="section-heading">{{ t("system.tasks") }}</h2>
          <dl class="mt-5 grid grid-cols-3 gap-4">
            <div
              v-for="item in [
                ['pendingTasks', 'system.pending'],
                ['runningTasks', 'system.running'],
                ['failedTasks', 'system.failed'],
              ] as const"
              :key="item[0]"
            >
              <dt class="subtle">{{ t(item[1]) }}</dt>
              <dd class="mt-2 text-xl font-medium tabular-nums">
                {{ status[item[0]] }}
              </dd>
            </div>
          </dl>
          <h3 class="mt-7 text-sm font-medium">{{ t("system.failures") }}</h3>
          <p v-if="!status.failures.length" class="subtle mt-4">
            {{ t("system.noFailures") }}
          </p>
          <div v-else class="mt-3 divide-y">
            <RouterLink
              v-for="failure in status.failures"
              :key="failure.id"
              :to="{
                path: '/app/images',
                query: { file: failure.fileId, status: 'all' },
              }"
              class="block py-4 hover:text-primary"
            >
              <p class="text-sm font-medium break-all">
                {{ failure.logicalKey }}
              </p>
              <p class="subtle mt-1">
                {{ kinds[failure.kind] }} · {{ date(failure.updatedAt) }}
              </p>
              <p class="mt-1 text-sm">{{ errorMessage(failure.error) }}</p>
            </RouterLink>
          </div>
        </section>
        <BackupPanel :database="status.database" />
        <p class="subtle">
          {{ t("system.checked", { time: date(status.checkedAt) }) }}
        </p>
      </div>
    </div>
    <Dialog
      :open="confirmClear"
      @update:open="
        (value) => {
          if (!clearing) confirmClear = value;
        }
      "
    >
      <DialogContent :busy="clearing">
        <DialogTitle>{{ t("system.clearCache") }}</DialogTitle>
        <DialogDescription>{{ t("system.clearCacheHint") }}</DialogDescription>
        <p v-if="clearError" role="alert" class="error-box">{{ clearError }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            :disabled="clearing"
            @click="confirmClear = false"
            >{{ t("ui.cancel") }}</Button
          >
          <Button :loading="clearing" @click="clearCache">{{
            t("system.clearCache")
          }}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
