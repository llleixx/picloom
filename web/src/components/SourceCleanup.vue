<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { RouterLink } from "vue-router";
import { Button } from "@/components/ui/button";
import { api, errorText, errorMessage, queryClient } from "@/lib/api";
import { t } from "@/lib/i18n";
import DeleteScope from "./DeleteScope.vue";
import type {
  CleanupDetail,
  CleanupPreview,
  CleanupJobView,
} from "../../../shared/api";
const props = defineProps<{ sourceId: string }>();
const emit = defineEmits<{ remove: [] }>();
const mode = ref<"delete" | "detach">("delete"),
  includeLast = ref(true),
  whole = ref(false),
  busy = ref(false),
  error = ref("");
const page = ref(0),
  selected = ref("");
const preview = useQuery({
  queryKey: computed(() => ["cleanup-preview", props.sourceId]),
  staleTime: 0,
  queryFn: () =>
    api<CleanupPreview>(
      `/api/storage-sources/${props.sourceId}/cleanup-preview`,
    ),
});
const latest = useQuery({
  queryKey: computed(() => ["cleanup-latest", props.sourceId]),
  staleTime: 0,
  queryFn: () =>
    api<CleanupJobView | null>(
      `/api/storage-sources/${props.sourceId}/cleanups/latest`,
    ),
});
const jobId = computed(() => selected.value || latest.data.value?.id || "");
const detail = useQuery({
  queryKey: computed(() => [
    "cleanup",
    props.sourceId,
    jobId.value,
    page.value,
  ]),
  enabled: computed(() => !!jobId.value),
  queryFn: () =>
    api<CleanupDetail>(
      `/api/storage-sources/${props.sourceId}/cleanups/${jobId.value}?limit=25&offset=${page.value * 25}`,
    ),
  refetchInterval: (query) =>
    query.state.data?.job.status === "active" ? 1500 : false,
});
watch(
  () => detail.data.value?.job,
  (job) => {
    if (job?.status === "active") {
      mode.value = job.mode;
      includeLast.value = job.include_last;
    }
  },
  { immediate: true },
);
watch(
  () => detail.data.value?.job.status,
  (status) => {
    if (status === "finished") {
      void preview.refetch();
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
      void queryClient.invalidateQueries({ queryKey: ["files"] });
    }
  },
);
const total = computed(() =>
  Object.values(detail.data.value?.counts ?? {}).reduce((sum, n) => sum + n, 0),
);
async function act(retry = false) {
  busy.value = true;
  error.value = "";
  try {
    const job = await api<CleanupJobView>(
      `/api/storage-sources/${props.sourceId}/cleanups${retry ? `/${jobId.value}/retry` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({
          mode: mode.value,
          includeLast: includeLast.value,
        }),
      },
    );
    selected.value = job.id;
    page.value = 0;
    await Promise.all([
      latest.refetch(),
      preview.refetch(),
      queryClient.invalidateQueries({ queryKey: ["cleanup", props.sourceId] }),
      queryClient.invalidateQueries({ queryKey: ["sources"] }),
    ]);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="space-y-4">
    <p v-if="preview.data.value">
      {{
        t("cleanup.preview", {
          total: preview.data.value.total,
          last: preview.data.value.withoutOtherReady,
        })
      }}
    </p>
    <div v-if="preview.data.value?.groups.length" class="space-y-1">
      <p>{{ t("cleanup.groups") }}</p>
      <RouterLink
        v-for="group in preview.data.value.groups"
        :key="group.id"
        :to="{ path: '/app/config/groups', query: { edit: group.id } }"
        class="block text-sm underline"
        >{{ group.name }}</RouterLink
      >
      <Button size="sm" variant="outline" @click="preview.refetch()">{{
        t("ui.refresh")
      }}</Button>
    </div>
    <DeleteScope
      v-model:mode="mode"
      v-model:include-last="includeLast"
      v-model:whole="whole"
      scoped
      :disabled="busy || detail.data.value?.job.status === 'active'"
    />
    <Button
      :loading="busy"
      :disabled="
        busy ||
        !!preview.data.value?.groups.length ||
        detail.data.value?.job.status === 'active' ||
        !preview.data.value
      "
      variant="destructive"
      @click="act()"
      >{{ t("cleanup.start") }}</Button
    >
    <p
      v-if="
        error || preview.error.value || latest.error.value || detail.error.value
      "
      role="alert"
      class="error-box"
    >
      {{
        error ||
        errorText(
          preview.error.value || latest.error.value || detail.error.value,
        )
      }}
    </p>
    <template v-if="detail.data.value">
      <div class="border-t pt-4 space-y-3" aria-live="polite">
        <p>
          {{ t("cleanup.result") }} ·
          {{
            t(
              detail.data.value.job.status === "active"
                ? "cleanup.active"
                : "cleanup.finished",
            )
          }}
          ·
          {{
            t(
              detail.data.value.job.mode === "detach"
                ? "removal.detach"
                : "removal.delete",
            )
          }}
        </p>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span
            v-for="(count, status) in detail.data.value.counts"
            :key="status"
            >{{ t(`cleanup.${status}`) }}: {{ count }}</span
          >
        </div>
        <p>
          {{ t("cleanup.remaining", { count: detail.data.value.remaining }) }}
        </p>
        <Button
          v-if="detail.data.value.counts.failed"
          size="sm"
          variant="outline"
          :disabled="busy || detail.data.value.job.status === 'active'"
          @click="act(true)"
          >{{ t("cleanup.retry") }}</Button
        >
        <ul class="space-y-2 text-sm">
          <li
            v-for="item in detail.data.value.items"
            :key="item.id"
            class="flex flex-wrap items-baseline gap-2"
          >
            <RouterLink
              :to="{ path: '/app/images', query: { file: item.file_id } }"
              class="truncate underline max-w-64"
              >{{ item.file_id }}</RouterLink
            >
            <span>{{ t(`cleanup.${item.status}`) }}</span
            ><span
              v-if="item.error && item.status === 'failed'"
              class="text-destructive"
              >{{ errorMessage(item.error) }}</span
            >
          </li>
        </ul>
        <div v-if="total > 25" class="flex gap-2 items-center">
          <Button
            size="sm"
            variant="outline"
            :disabled="page === 0"
            @click="page--"
            >{{ t("ui.previousPage") }}</Button
          ><span>{{ page + 1 }} / {{ Math.ceil(total / 25) }}</span
          ><Button
            size="sm"
            variant="outline"
            :disabled="(page + 1) * 25 >= total"
            @click="page++"
            >{{ t("ui.nextPage") }}</Button
          >
        </div>
        <Button
          v-if="
            detail.data.value.job.status === 'finished' &&
            detail.data.value.remaining === 0 &&
            !detail.data.value.groups.length
          "
          size="sm"
          variant="outline"
          @click="emit('remove')"
          >{{ t("cleanup.removeSource") }}</Button
        >
      </div>
    </template>
  </div>
</template>
