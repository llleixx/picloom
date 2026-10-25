<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { SystemStatistics, SystemStatus } from "../../../shared/api";
import { api, errorText } from "@/lib/api";
import { t, formatNumber, locale } from "@/lib/i18n";
import { localDayBoundaries, localDate } from "@/lib/date-range";
import { date, size } from "@/lib/utils";
import { Button } from "@/components/ui/button";
defineProps<{ status?: SystemStatus }>();
const days = ref(30);
const measure = ref<"count" | "bytes">("count");
const composition = ref<"count" | "bytes">("bytes");
const selectedDay = ref<number | null>(null);
const query = useQuery({
  queryKey: computed(() => ["system-statistics", days.value]),
  queryFn: () => {
    const params = new URLSearchParams();
    for (const boundary of localDayBoundaries(days.value))
      params.append("boundary", String(boundary));
    return api<SystemStatistics>(`/api/system/statistics?${params}`);
  },
  refetchInterval: 60000,
});
const stats = computed(() => query.data.value);
watch(days, () => {
  selectedDay.value = null;
});
const total = computed(
  () =>
    stats.value?.trend.reduce(
      (a, d) => ({
        count: a.count + d.uploads + d.imports,
        bytes: a.bytes + d.uploadBytes + d.importBytes,
        unknown: a.unknown + d.unknownBytes,
      }),
      { count: 0, bytes: 0, unknown: 0 },
    ) ?? { count: 0, bytes: 0, unknown: 0 },
);
const value = (
  d: SystemStatistics["trend"][number],
  origin: "upload" | "import",
) =>
  measure.value === "count"
    ? d[origin === "upload" ? "uploads" : "imports"]
    : d[origin === "upload" ? "uploadBytes" : "importBytes"];
const maximum = computed(() =>
  Math.max(
    1,
    ...(stats.value?.trend.map(
      (d) => value(d, "upload") + value(d, "import"),
    ) ?? []),
  ),
);
const dayLabel = (day: number) =>
  new Intl.DateTimeFormat(locale.value, {
    month: "short",
    day: "numeric",
  }).format(day);
const chartLabel = (d: SystemStatistics["trend"][number]) =>
  `${dayLabel(d.day)} · ${t("statistics.uploads")}: ${formatNumber(d.uploads)} · ${t("statistics.imports")}: ${formatNumber(d.imports)} · ${size(d.uploadBytes + d.importBytes)}`;
const selected = computed(() =>
  stats.value?.trend.find((d) => d.day === selectedDay.value),
);
const formats = computed(() =>
  [...(stats.value?.formats ?? [])].sort(
    (a, b) => b[composition.value] - a[composition.value],
  ),
);
const formatTotal = computed(() =>
  formats.value.reduce((sum, f) => sum + f[composition.value], 0),
);
const formatColor = (mime: string | null) => {
  const colors: Record<string, string> = {
    "image/png": "#35a77b",
    "image/jpeg": "#568bd4",
    "image/webp": "#a27ad0",
    "image/gif": "#d69842",
    "image/avif": "#cf6d87",
    "image/svg+xml": "#43a6b1",
  };
  if (!mime) return "#89939e";
  if (colors[mime]) return colors[mime];
  const hash = [...mime].reduce(
    (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
    0,
  );
  return `hsl(${hash % 360} 48% 55%)`;
};
const percent = (ratio: number) =>
  formatNumber(ratio, { style: "percent", maximumFractionDigits: 1 });
const segments = computed(() => {
  let offset = 0;
  return formats.value.map((f) => {
    const share = formatTotal.value
      ? (f[composition.value] / formatTotal.value) * 100
      : 0;
    const segment = { ...f, share, offset, color: formatColor(f.mimeType) };
    offset += share;
    return segment;
  });
});
const storageMax = computed(() =>
  Math.max(1, ...(stats.value?.storage.map((s) => s.bytes) ?? [])),
);
const images = (query: Record<string, string> = {}) => ({
  path: "/app/images",
  query: { scope: "all", ...query },
});
const additions = (day?: number) =>
  images({
    status: "ready",
    from: localDate(new Date(day ?? stats.value!.trend[0]!.day)),
    to: localDate(
      new Date(
        (day === undefined
          ? stats.value!.trend.at(-1)!.before
          : stats.value!.trend.find((d) => d.day === day)!.before) - 1,
      ),
    ),
  });
</script>
<template>
  <div class="space-y-7">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="font-medium">{{ t("statistics.summary") }}</h2>
      <select
        v-model="days"
        class="native-select w-auto"
        :aria-label="t('statistics.period')"
      >
        <option v-for="n in [7, 30, 90]" :key="n" :value="n">
          {{ t("statistics.lastDays", { days: n }) }}
        </option>
      </select>
    </div>
    <p v-if="query.isPending.value" class="subtle" role="status">
      {{ t("ui.loading") }}
    </p>
    <div v-if="query.isError.value" class="space-y-3">
      <p class="error-box" role="alert">{{ errorText(query.error.value) }}</p>
      <Button variant="outline" @click="query.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <template v-if="stats">
      <dl class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div class="rounded-xl border p-4">
          <dt class="subtle">
            {{ t("system.images") }}
          </dt>
          <dd class="mt-2 text-2xl font-medium tabular-nums">
            <RouterLink :to="images()" class="hover:text-primary">{{
              formatNumber(stats.readyFiles)
            }}</RouterLink>
          </dd>
        </div>
        <div class="rounded-xl border p-4">
          <dt class="subtle">
            {{ t("system.originalBytes") }}
          </dt>
          <dd class="mt-2 text-2xl font-medium tabular-nums">
            {{ size(stats.originalBytes) }}
          </dd>
          <p v-if="stats.unknownBytes" class="subtle mt-1">
            {{ t("statistics.unknownSizes", { count: stats.unknownBytes }) }}
          </p>
        </div>
        <div class="rounded-xl border p-4">
          <dt class="subtle">{{ t("statistics.added") }}</dt>
          <dd class="mt-2 text-2xl font-medium tabular-nums">
            <RouterLink :to="additions()" class="hover:text-primary">{{
              formatNumber(total.count)
            }}</RouterLink>
          </dd>
          <p class="subtle mt-1">{{ size(total.bytes) }}</p>
        </div>
        <div class="rounded-xl border p-4">
          <dt class="subtle">
            {{ t("statistics.attention") }}
          </dt>
          <dd class="mt-2 text-2xl font-medium tabular-nums">
            <RouterLink
              :to="images({ status: 'attention' })"
              :class="stats.attentionFiles ? 'text-destructive' : ''"
              >{{ formatNumber(stats.attentionFiles) }}</RouterLink
            >
          </dd>
        </div>
      </dl>
      <section class="border-b pb-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-medium">{{ t("statistics.trend") }}</h2>
          <div class="flex gap-1" :aria-label="t('statistics.measure')">
            <Button
              size="sm"
              :variant="measure === 'count' ? 'secondary' : 'ghost'"
              :aria-pressed="measure === 'count'"
              @click="measure = 'count'"
              >{{ t("statistics.count") }}</Button
            >
            <Button
              size="sm"
              :variant="measure === 'bytes' ? 'secondary' : 'ghost'"
              :aria-pressed="measure === 'bytes'"
              @click="measure = 'bytes'"
              >{{ t("statistics.bytes") }}</Button
            >
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span class="inline-flex items-center gap-2"
            ><i class="h-2 w-2 rounded-sm bg-primary" />{{
              t("statistics.uploads")
            }}</span
          >
          <span class="inline-flex items-center gap-2"
            ><i class="h-2 w-2 rounded-sm bg-primary/35" />{{
              t("statistics.imports")
            }}</span
          >
        </div>
        <div
          class="mt-5 flex gap-3"
          role="group"
          :aria-label="t('statistics.trend')"
        >
          <div
            class="flex h-48 shrink-0 flex-col justify-between text-right text-xs tabular-nums text-muted-foreground"
            aria-hidden="true"
          >
            <span>{{
              measure === "bytes" ? size(maximum) : formatNumber(maximum)
            }}</span
            ><span>{{
              measure === "bytes"
                ? size(maximum / 2)
                : formatNumber(maximum / 2, { maximumFractionDigits: 1 })
            }}</span
            ><span>0</span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="relative h-48 border-b">
              <div
                class="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed"
              />
              <div
                class="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed"
              />
              <div
                class="relative grid h-full items-end gap-px sm:gap-1"
                :style="{
                  gridTemplateColumns: `repeat(${stats.trend.length}, minmax(0, 1fr))`,
                }"
              >
                <button
                  v-for="d in stats.trend"
                  :key="d.day"
                  type="button"
                  class="flex h-full min-w-0 flex-col justify-end rounded-t-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  :class="selectedDay === d.day ? 'bg-muted' : ''"
                  :aria-label="chartLabel(d)"
                  :aria-pressed="selectedDay === d.day"
                  :title="chartLabel(d)"
                  @click="selectedDay = d.day"
                >
                  <span
                    class="block w-full rounded-t-sm bg-primary/35"
                    :style="{
                      height: `${(value(d, 'import') / maximum) * 100}%`,
                    }"
                  />
                  <span
                    class="block w-full bg-primary"
                    :style="{
                      height: `${(value(d, 'upload') / maximum) * 100}%`,
                    }"
                  />
                </button>
              </div>
            </div>
            <div
              class="mt-2 flex justify-between text-xs text-muted-foreground"
              aria-hidden="true"
            >
              <span>{{ dayLabel(stats.trend[0]!.day) }}</span
              ><span>{{
                dayLabel(stats.trend[Math.floor(stats.trend.length / 2)]!.day)
              }}</span
              ><span>{{ dayLabel(stats.trend.at(-1)!.day) }}</span>
            </div>
          </div>
        </div>
        <select
          v-model="selectedDay"
          class="native-select mt-4 w-auto sm:hidden"
          :aria-label="t('statistics.day')"
        >
          <option :value="null">{{ t("statistics.selectDay") }}</option>
          <option v-for="d in stats.trend" :key="d.day" :value="d.day">
            {{ dayLabel(d.day) }}
          </option>
        </select>
        <div
          v-if="selected"
          class="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-2 text-sm"
          aria-live="polite"
        >
          <span>{{ chartLabel(selected) }}</span>
          <RouterLink
            class="text-primary hover:underline"
            :to="additions(selected.day)"
            >{{ t("statistics.viewImages") }} →</RouterLink
          >
        </div>
        <p v-if="total.unknown" class="subtle mt-1">
          {{ t("statistics.historyUnknown", { count: total.unknown }) }}
        </p>
      </section>
      <div class="grid gap-8 lg:grid-cols-2">
        <section class="min-w-0">
          <h2 class="font-medium">{{ t("statistics.storage") }}</h2>
          <p v-if="!stats.storage.length" class="subtle mt-6">
            {{ t("statistics.noStorage") }}
          </p>
          <div class="mt-5 space-y-5">
            <RouterLink
              v-for="s in stats.storage"
              :key="s.id"
              :to="images({ source: s.id, status: 'all' })"
              class="block"
            >
              <div class="mb-2 flex flex-wrap justify-between gap-2 text-sm">
                <span class="min-w-0 break-all">{{ s.name }}</span
                ><span class="tabular-nums text-muted-foreground"
                  >{{ size(s.bytes)
                  }}<template v-if="s.limit">
                    / {{ size(s.limit) }} ·
                    {{ percent(s.bytes / s.limit) }}</template
                  ></span
                >
              </div>
              <div
                class="h-2 overflow-hidden rounded-full bg-muted"
                role="img"
                :aria-label="`${s.name}: ${size(s.bytes)}${s.limit ? ' / ' + size(s.limit) : ''}`"
              >
                <div
                  class="h-full rounded-full"
                  :class="
                    s.limit && s.bytes >= s.limit
                      ? 'bg-destructive'
                      : 'bg-primary/70'
                  "
                  :style="{
                    width: `${Math.min(100, (s.bytes / storageMax) * 100)}%`,
                  }"
                />
              </div>
            </RouterLink>
          </div>
        </section>
        <section class="min-w-0">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="font-medium">{{ t("statistics.formats") }}</h2>
            <select
              v-model="composition"
              class="native-select w-auto"
              :aria-label="t('statistics.measure')"
            >
              <option value="bytes">{{ t("statistics.bytes") }}</option>
              <option value="count">{{ t("statistics.count") }}</option>
            </select>
          </div>
          <div
            class="mt-5 flex flex-col items-center gap-5 sm:flex-row sm:items-center"
          >
            <svg
              v-if="formatTotal > 0"
              viewBox="0 0 120 120"
              class="h-40 w-40 shrink-0"
              role="img"
              :aria-label="t('statistics.formats')"
              data-testid="format-chart"
            >
              <title>
                {{ t("statistics.formats") }} ·
                {{
                  t(
                    composition === "bytes"
                      ? "statistics.bytes"
                      : "statistics.count",
                  )
                }}
              </title>
              <circle
                v-for="f in segments.filter((f) => f.share > 0)"
                :key="f.mimeType ?? 'unknown'"
                cx="60"
                cy="60"
                r="48"
                fill="none"
                :stroke="f.color"
                stroke-width="18"
                pathLength="100"
                :stroke-dasharray="`${f.share} ${100 - f.share}`"
                :stroke-dashoffset="-f.offset"
                transform="rotate(-90 60 60)"
              />
            </svg>
            <p v-else class="subtle py-8">{{ t("statistics.noFormatData") }}</p>
            <ul v-if="formats.length" class="w-full min-w-0 flex-1 space-y-3">
              <li
                v-for="f in segments"
                :key="f.mimeType ?? 'unknown'"
                class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
              >
                <span class="inline-flex min-w-0 items-center gap-2">
                  <i
                    class="h-2.5 w-2.5 shrink-0 rounded-full"
                    :style="{ backgroundColor: f.color }"
                    aria-hidden="true"
                  />
                  <RouterLink
                    v-if="f.mimeType"
                    :to="images({ mimeType: f.mimeType })"
                    class="break-all hover:text-primary"
                    >{{
                      f.mimeType.replace("image/", "").toUpperCase()
                    }}</RouterLink
                  >
                  <span v-else>{{ t("ui.unknown") }}</span>
                </span>
                <span class="tabular-nums text-muted-foreground"
                  >{{
                    composition === "bytes"
                      ? size(f.bytes)
                      : formatNumber(f.count)
                  }}
                  · {{ percent(f.share / 100) }}</span
                >
              </li>
            </ul>
          </div>
          <RouterLink
            class="mt-5 inline-block text-sm text-primary hover:underline"
            :to="images({ sort: 'size', order: 'desc' })"
            >{{ t("statistics.largeFiles") }} →</RouterLink
          >
        </section>
      </div>
      <section class="border-t pt-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-medium">{{ t("statistics.attention") }}</h2>
          <RouterLink
            v-if="stats.attentionFiles"
            class="text-sm text-primary hover:underline"
            :to="images({ status: 'attention' })"
            >{{ t("statistics.viewImages") }} →</RouterLink
          >
        </div>
        <p v-if="!stats.attentionFiles" class="subtle mt-3">
          {{ t("statistics.noAttention") }}
        </p>
        <div v-if="stats.attentionFiles" class="mt-3 flex flex-wrap gap-2">
          <RouterLink
            v-for="key in [
              'failed',
              'blocked',
              'delete_failed',
              'replica_error',
            ]"
            :key="key"
            :to="images({ status: key })"
            class="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >{{
              t(
                key === "failed"
                  ? "ui.uploadFailed"
                  : key === "blocked"
                    ? "images.blocked"
                    : key === "delete_failed"
                      ? "ui.deleteFailed"
                      : "images.replicaError",
              )
            }}</RouterLink
          >
        </div>
        <div v-if="status?.failures.length" class="mt-3 divide-y">
          <RouterLink
            v-for="failure in status.failures.slice(0, 3)"
            :key="failure.id"
            :to="images({ status: 'all', file: failure.fileId })"
            class="flex flex-wrap items-center justify-between gap-2 py-3 text-sm hover:text-primary"
            ><span class="break-all">{{ failure.logicalKey }}</span
            ><span class="text-muted-foreground">{{
              date(failure.updatedAt)
            }}</span></RouterLink
          >
        </div>
      </section>
      <p class="subtle">
        {{ t("system.checked", { time: date(stats.checkedAt) }) }}
      </p>
    </template>
  </div>
</template>
