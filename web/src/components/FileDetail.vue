<script setup lang="ts">
import ReplaceImage from "./ReplaceImage.vue";
import AccessLinkBuilder from "./AccessLinkBuilder.vue";
import DeleteScope from "./DeleteScope.vue";
import ProcessingResults from "./ProcessingResults.vue";
import { t } from "@/lib/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Trash2, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { FileView } from "../../../shared/api";
import { api, errorMessage, errorText, queryClient, isAdmin } from "@/lib/api";
import { date, size, fileStatus } from "@/lib/utils";
import ImagePreview from "./ImagePreview.vue";
import type { OperationsView } from "../../../shared/config";
const props = defineProps<{
    id: string;
    sourceId?: string;
    canPrevious?: boolean;
    canNext?: boolean;
    navigating?: boolean;
    navigationError?: string;
  }>(),
  emit = defineEmits<{
    close: [];
    previous: [];
    next: [];
    replaced: [id: string];
  }>();
const detail = useQuery({
  queryKey: ["file", props.id],
  queryFn: ({ signal }) =>
    api<FileView>("/api/files/" + encodeURIComponent(props.id), { signal }),
  refetchInterval: (query) =>
    query.state.data?.status === "deleting" ||
    query.state.data?.status === "preparing"
      ? 1500
      : query.state.data?.backgroundPending
        ? 3000
        : false,
});
const restoring = ref(false);
async function restoreAccess() {
  restoring.value = true;
  operationError.value = "";
  try {
    await api("/api/files/" + encodeURIComponent(props.id) + "/unblock", {
      method: "POST",
    });
    await detail.refetch();
    await queryClient.invalidateQueries({ queryKey: ["files"] });
  } catch (error) {
    operationError.value = errorText(error);
  } finally {
    restoring.value = false;
  }
}
const file = detail.data;
const operations = useQuery({
  enabled: isAdmin,
  queryKey: ["operations", props.id],
  queryFn: ({ signal }) =>
    api<OperationsView>(
      "/api/files/" + encodeURIComponent(props.id) + "/operations",
      { signal },
    ),
  refetchInterval: (query) =>
    file.value?.status === "deleting" ||
    query.state.data?.tasks.some((t) =>
      ["pending", "running"].includes(t.status),
    )
      ? 2000
      : false,
});
watch(
  () => operations.data.value?.replicas.map((r) => r.status).join(","),
  (value, old) => {
    if (old !== undefined && value !== old)
      void queryClient.invalidateQueries({ queryKey: ["files"] });
  },
);
const operationError = ref("");
const retrying = ref("");
function replicaRunning(id: string) {
  return operations.data.value?.tasks.some(
    (task) => task.replicaId === id && task.status === "running",
  );
}
function replicaRetry(id: string) {
  if (
    operations.data.value?.replicas.find((replica) => replica.id === id)
      ?.status === "deleted"
  )
    return;
  return operations.data.value?.tasks.find(
    (task) =>
      task.replicaId === id &&
      task.status === "failed" &&
      task.retryError !== "CONFLICT",
  );
}
const operationKinds = computed<Record<string, string>>(() => ({
  write: t("ui.replication"),
  action: t("ui.postSaveAction"),
  delete: t("ui.replicaDeletion"),
}));
const operationStatuses = computed<Record<string, string>>(() => ({
  pending: t("ui.pending"),
  running: t("ui.running"),
  success: t("ui.completed"),
  failed: t("ui.failed"),
  cancelled: t("ui.cancelled"),
  writing: t("ui.writing"),
  ready: t("ui.ready"),
  write_failed: t("ui.writeFailed"),
  delete_pending: t("ui.pendingDeletion"),
  deleting: t("ui.deleting"),
  delete_failed: t("ui.deleteFailed"),
  deleted: t("ui.deleted"),
}));
async function retryTask(id: string) {
  if (retrying.value) return;
  retrying.value = id;
  operationError.value = "";
  try {
    await api("/api/tasks/" + id + "/retry", { method: "POST" });
    await operations.refetch();
    await detail.refetch();
    await queryClient.invalidateQueries({ queryKey: ["files"] });
    await queryClient.invalidateQueries({ queryKey: ["sources"] });
  } catch (e) {
    operationError.value = errorText(e);
  } finally {
    retrying.value = "";
  }
}
const confirming = ref(false),
  deleting = ref(false),
  deleteError = ref("");
function navigateKey(event: KeyboardEvent) {
  if (
    confirming.value ||
    deleting.value ||
    props.navigating ||
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  )
    return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input,textarea,select,[contenteditable=true]")) return;
  if (event.key === "ArrowLeft" && props.canPrevious) {
    event.preventDefault();
    emit("previous");
  }
  if (event.key === "ArrowRight" && props.canNext) {
    event.preventDefault();
    emit("next");
  }
}
onMounted(() => window.addEventListener("keydown", navigateKey));
onUnmounted(() => window.removeEventListener("keydown", navigateKey));
watch(
  () => file.value?.status,
  (status, old) => {
    if (isAdmin.value && status !== old) void operations.refetch();
    if (old !== undefined && status !== old)
      void queryClient.invalidateQueries({ queryKey: ["files"] });
  },
);
const deleteWhole = ref(false),
  includeLast = ref(false),
  replicaTarget = ref(""),
  terminatingReplica = ref(false);
function confirmRemoval(replicaId = "", terminate = false) {
  terminatingReplica.value = terminate;
  replicaTarget.value = replicaId;
  deleteWhole.value = false;
  includeLast.value = false;
  deleteError.value = "";
  confirming.value = true;
}
const lastReplica = computed(
  () =>
    !!replicaTarget.value &&
    !operations.data.value?.replicas.some(
      (r) => r.id !== replicaTarget.value && r.status === "ready",
    ),
);
async function remove() {
  deleting.value = true;
  deleteError.value = "";
  try {
    const sourceOnly =
      !replicaTarget.value && props.sourceId && !deleteWhole.value;
    if (terminatingReplica.value && replicaTarget.value) {
      await api(
        `/api/files/${encodeURIComponent(props.id)}/replicas/${encodeURIComponent(replicaTarget.value)}/terminate`,
        {
          method: "POST",
          body: JSON.stringify({ confirm: true }),
        },
      );
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
    } else if (replicaTarget.value && !lastReplica.value) {
      await api(
        `/api/files/${encodeURIComponent(props.id)}/replicas/${encodeURIComponent(replicaTarget.value)}`,
        { method: "DELETE" },
      );
    } else if (sourceOnly) {
      const result = await api<import("../../../shared/api").BatchDeleteResult>(
        "/api/files/batch-delete",
        {
          method: "POST",
          body: JSON.stringify({
            ids: [props.id],
            sourceId: props.sourceId,
            includeLast: includeLast.value,
          }),
        },
      );
      if (!result.results[0]?.accepted)
        throw new Error(errorMessage(result.results[0]?.error));
    } else {
      await api("/api/files/" + encodeURIComponent(props.id), {
        method: "DELETE",
      });
      queryClient.setQueryData<FileView>(["file", props.id], (old) =>
        old ? { ...old, status: "deleting", error: null } : old,
      );
    }
    await operations.refetch();
    confirming.value = false;
    await queryClient.invalidateQueries({ queryKey: ["files"] });
    await detail.refetch();
  } catch (e) {
    deleteError.value = errorText(e);
  } finally {
    deleting.value = false;
  }
}
</script>
<template>
  <Sheet
    :open="true"
    @update:open="
      (value) => {
        if (!value) emit('close');
      }
    "
    ><SheetContent class="w-full overflow-y-auto p-6 sm:max-w-xl">
      <SheetTitle>{{ t("ui.imageDetails") }}</SheetTitle
      ><SheetDescription>{{ t("ui.previewProcessAndShare") }}</SheetDescription>
      <div class="mt-4 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="!canPrevious || navigating || deleting || confirming"
          :aria-label="t('images.previousImage')"
          @click="emit('previous')"
          ><ChevronLeft />{{ t("images.previousImage") }}</Button
        >
        <Button
          variant="outline"
          size="sm"
          :disabled="!canNext || navigating || deleting || confirming"
          :aria-label="t('images.nextImage')"
          @click="emit('next')"
          >{{ t("images.nextImage") }}<ChevronRight
        /></Button>
      </div>
      <p v-if="navigationError" role="alert" class="error-box">
        {{ navigationError }}
      </p>
      <p v-if="detail.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
      <div v-else-if="detail.error.value" role="alert" class="error-box">
        {{ errorText(detail.error.value)
        }}<Button variant="ghost" @click="detail.refetch()">{{
          t("ui.retry")
        }}</Button>
      </div>
      <template v-else-if="file">
        <div
          v-if="
            file.status === 'ready' || (isAdmin && file.status === 'blocked')
          "
          class="mt-5 h-64 overflow-hidden rounded-xl border"
        >
          <ImagePreview
            :src="
              file.status === 'blocked'
                ? `/api/files/${encodeURIComponent(file.id)}/preview`
                : file.url
            "
            :contain="true"
          />
        </div>
        <div
          v-else
          class="mt-5 rounded-lg bg-muted p-7 text-center"
          role="status"
        >
          {{ fileStatus(file) }}
          <p v-if="file.status === 'deleting'" class="mt-2 subtle">
            {{ t("ui.publicAccessDisabledCleanupPending") }}
          </p>
        </div>
        <div v-if="file.status === 'blocked'" class="mt-4 space-y-2">
          <p class="subtle">{{ t("images.blockedHint") }}</p>
          <Button
            v-if="isAdmin"
            variant="outline"
            :loading="restoring"
            @click="restoreAccess"
            >{{ t("images.restoreAccess") }}</Button
          >
        </div>
        <p v-if="file.error" class="mt-4 error-box">
          {{
            file.error === "DELETE_FAILED"
              ? t("ui.cleanupFailedCheckStorageIfRetriesKeep")
              : errorMessage(file.error)
          }}
        </p>
        <dl
          class="my-5 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm"
        >
          <template v-if="isAdmin"
            ><dt class="text-muted-foreground">{{ t("users.owner") }}</dt>
            <dd>{{ file.ownerName ?? t("users.guest") }}</dd></template
          >
          <dt class="text-muted-foreground">{{ t("ui.logicalPath") }}</dt>
          <dd class="break-all">{{ file.logicalKey }}</dd>
          <template v-if="file.storageKey !== file.logicalKey">
            <dt class="text-muted-foreground">{{ t("ui.storagePath") }}</dt>
            <dd class="break-all">{{ file.storageKey }}</dd>
          </template>
          <dt class="text-muted-foreground">{{ t("ui.fileId") }}</dt>
          <dd class="break-all font-mono text-xs">{{ file.id }}</dd>
          <dt class="text-muted-foreground">{{ t("ui.formatSize") }}</dt>
          <dd>
            {{ file.mimeType ?? t("ui.unknown") }} · {{ size(file.byteSize) }}
          </dd>
          <dt class="text-muted-foreground">{{ t("ui.dimensions") }}</dt>
          <dd>
            {{ file.width ?? t("ui.unknown") }} ×
            {{ file.height ?? t("ui.unknown") }}
          </dd>
          <dt class="text-muted-foreground">{{ t("ui.created") }}</dt>
          <dd>{{ date(file.createdAt) }}</dd>
          <dt class="text-muted-foreground">{{ t("ui.status") }}</dt>
          <dd>{{ fileStatus(file) }}</dd>
        </dl>
        <ProcessingResults
          v-if="isAdmin && file.processingResults?.length"
          :results="file.processingResults"
        />
        <AccessLinkBuilder
          v-if="file.status === 'ready'"
          :key="file.id"
          :url="file.url"
        />
        <div
          v-if="!['deleted', 'deleting', 'delete_failed'].includes(file.status)"
          class="mt-4 flex flex-wrap items-center gap-2"
        >
          <ReplaceImage
            v-if="file.status === 'ready'"
            :file="file"
            @replaced="(id) => emit('replaced', id)"
          />
          <Button variant="destructive" class="w-36" @click="confirmRemoval()">
            <Trash2 />{{ t("ui.deleteImage") }}
          </Button>
        </div>
        <section v-if="isAdmin" class="mt-6 space-y-4 border-t pt-5">
          <h3 class="font-medium">{{ t("ui.replicas") }}</h3>
          <p v-if="operations.error.value" class="error-box">
            {{ errorText(operations.error.value)
            }}<Button variant="ghost" @click="operations.refetch()">{{
              t("ui.retry")
            }}</Button>
          </p>
          <div
            v-for="replica in operations.data.value?.replicas"
            :key="replica.id"
            class="rounded-lg border p-3 text-sm"
          >
            {{
              replica.instanceDeleted
                ? t("replicas.instanceDeleted", { id: replica.instanceId })
                : replica.name
            }}
            ·
            {{ operationStatuses[replica.status] ?? replica.status }}
            <Button
              v-if="
                ['ready', 'blocked'].includes(file.status) &&
                ['ready', 'pending', 'write_failed'].includes(replica.status) &&
                !replicaRunning(replica.id)
              "
              variant="ghost"
              size="sm"
              class="ml-2"
              @click="confirmRemoval(replica.id)"
              >{{ t("replicas.delete") }}</Button
            >
            <Button
              v-if="replicaRetry(replica.id)"
              variant="outline"
              size="sm"
              class="ml-2"
              :loading="retrying === replicaRetry(replica.id)?.id"
              :disabled="!!retrying || !!replicaRetry(replica.id)?.retryError"
              @click="retryTask(replicaRetry(replica.id)!.id)"
              >{{ t("ui.retry") }}</Button
            >
            <Button
              v-if="
                replica.status === 'delete_failed' &&
                !replicaRunning(replica.id)
              "
              variant="ghost"
              size="sm"
              class="ml-2"
              @click="confirmRemoval(replica.id, true)"
              >{{ t("replicas.terminate") }}</Button
            >
            <p
              v-if="replicaRetry(replica.id)?.retryError"
              class="mt-1 text-xs text-muted-foreground"
            >
              {{ errorMessage(replicaRetry(replica.id)?.retryError) }}
            </p>
          </div>
          <h3 class="font-medium">{{ t("ui.backgroundOperations") }}</h3>
          <p v-if="!operations.data.value?.tasks.length" class="subtle">
            {{ t("ui.noBackgroundTasks") }}
          </p>
          <div
            v-for="task in operations.data.value?.tasks"
            :key="task.id"
            class="rounded-lg border p-3 text-sm"
          >
            <p>
              {{ operationKinds[task.kind] }}
              · {{ operationStatuses[task.status] ?? task.status }}
              <span v-if="task.failedStep" :title="task.failedStep.id">
                · {{ task.failedStep.name }}</span
              >
            </p>
            <p class="mt-1 subtle">
              {{ t("tasks.attempts", { count: task.attempts })
              }}{{ task.error ? " · " + errorMessage(task.error) : "" }}
            </p>
            <div class="mt-2 flex gap-2">
              <Button
                v-if="
                  task.status === 'failed' &&
                  task.kind === 'action' &&
                  task.retryError !== 'CONFLICT'
                "
                variant="outline"
                size="sm"
                :loading="retrying === task.id"
                :disabled="!!retrying || !!task.retryError"
                @click="retryTask(task.id)"
                >{{ t("ui.retryTask") }}</Button
              >
              <span
                v-if="
                  task.status === 'failed' &&
                  task.kind === 'action' &&
                  task.retryError &&
                  task.retryError !== 'CONFLICT'
                "
                class="text-xs text-muted-foreground self-center"
                >{{ errorMessage(task.retryError) }}</span
              >
            </div>
          </div>
          <p v-if="operationError" role="alert" class="error-box">
            {{ operationError }}
          </p>
        </section>
      </template>
      <Dialog v-model:open="confirming"
        ><DialogContent :busy="deleting"
          ><DialogTitle>{{
            terminatingReplica ? t("replicas.terminate") : t("ui.deleteImage2")
          }}</DialogTitle
          ><DialogDescription>{{
            terminatingReplica
              ? t("replicas.terminateConfirm")
              : replicaTarget
                ? lastReplica
                  ? t("replicas.last")
                  : t("replicas.confirm")
                : props.sourceId && !deleteWhole
                  ? t("replicas.confirm")
                  : t("ui.thePublicUrlStopsWorkingImmediatelyThis")
          }}</DialogDescription>
          <DeleteScope
            v-if="props.sourceId && !replicaTarget"
            v-model:whole="deleteWhole"
            v-model:include-last="includeLast"
          />
          <p v-if="deleteError" role="alert" class="error-box">
            {{ deleteError }}
          </p>
          <div class="flex justify-end gap-2">
            <Button
              variant="outline"
              :disabled="deleting"
              @click="confirming = false"
              >{{ t("ui.cancel") }}</Button
            ><Button
              variant="destructive"
              :loading="deleting"
              @click="remove"
              >{{
                deleting
                  ? t("ui.deletingNow")
                  : terminatingReplica
                    ? t("replicas.terminate")
                    : t("ui.confirmDelete")
              }}</Button
            >
          </div></DialogContent
        ></Dialog
      >
    </SheetContent></Sheet
  >
</template>
