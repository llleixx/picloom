<script setup lang="ts">
import OrganizationEditor from "./OrganizationEditor.vue";
import ReplaceImage from "./ReplaceImage.vue";
import AccessLinkBuilder from "./AccessLinkBuilder.vue";
import DeleteScope from "./DeleteScope.vue";
import ProcessingResults from "./ProcessingResults.vue";
import { t } from "@/lib/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { ChevronLeft, ChevronRight, Copy, UserRound, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetClose,
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
import {
  api,
  ApiError,
  errorMessage,
  errorText,
  queryClient,
  isAdmin,
  copy,
} from "@/lib/api";
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
watch(detail.error, (error) => {
  if (error instanceof ApiError && error.status === 404) {
    void queryClient.invalidateQueries({ queryKey: ["files"] });
    emit("close");
  }
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
  () =>
    JSON.stringify([
      operations.data.value?.replicas.map((r) => r.status),
      operations.data.value?.tasks.map((t) => t.status),
    ]),
  (value, old) => {
    if (old !== undefined && value !== old)
      void queryClient.invalidateQueries({ queryKey: ["files"] });
  },
);
const storagePanel = ref<HTMLDetailsElement>(),
  processingPanel = ref<HTMLDetailsElement>();
const failedTasks = computed(() => {
  const status = file.value?.status;
  const current = operations.data.value;
  if (!status || !current) return [];
  return current.tasks.filter((task) => {
    if (task.status !== "failed") return false;
    const replica = current.replicas.find((r) => r.id === task.replicaId);
    if (task.kind === "delete")
      return (
        ["ready", "blocked", "deleting", "delete_failed"].includes(status) &&
        replica?.status === "delete_failed"
      );
    if (!["ready", "blocked"].includes(status)) return false;
    return (
      task.kind === "action" ||
      (task.kind === "write" && replica?.status === "write_failed")
    );
  });
});
const failedTaskCount = computed(() => failedTasks.value.length);
const activeTaskCount = computed(
  () =>
    operations.data.value?.tasks.filter((task) =>
      ["pending", "running"].includes(task.status),
    ).length ?? 0,
);
const replicaIssue = computed(() =>
  failedTasks.value.some((task) => task.kind !== "action"),
);
function inspectOperations() {
  const panel = processingPanel.value;
  if (panel) {
    panel.open = true;
    panel.scrollIntoView({ block: "nearest" });
  }
}
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
  deleted: t("removal.removed"),
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
  if (
    target?.closest(
      "input,textarea,select,[contenteditable=true],[role=menu],[role=option],summary",
    )
  )
    return;
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
  removalMode = ref<"delete" | "detach">("delete"),
  replicaTarget = ref("");
const replicaScope = computed(
  () => !!replicaTarget.value || (!!props.sourceId && !deleteWhole.value),
);
const removalTitle = computed(() =>
  t(
    removalMode.value === "detach"
      ? replicaScope.value
        ? "removal.detachReplicaTitle"
        : "removal.detachImageTitle"
      : replicaScope.value
        ? "removal.deleteReplicaTitle"
        : "ui.deleteImage2",
  ),
);
const deletionNeedsRetry = computed(() => {
  if (removalMode.value !== "delete") return false;
  if (file.value?.status === "delete_failed") return true;
  const target = operations.data.value?.replicas.find((replica) =>
    replicaTarget.value
      ? replica.id === replicaTarget.value
      : props.sourceId &&
        !deleteWhole.value &&
        replica.instanceId === props.sourceId,
  );
  return (
    target?.status === "delete_failed" &&
    !operations.data.value?.tasks.some(
      (task) =>
        task.replicaId === target.id &&
        ["pending", "running"].includes(task.status),
    )
  );
});
function confirmRemoval(replicaId = "") {
  removalMode.value = "delete";
  replicaTarget.value = replicaId;
  deleteWhole.value = false;
  deleteError.value = "";
  confirming.value = true;
}
async function remove() {
  if (deletionNeedsRetry.value) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    const sourceOnly =
      !replicaTarget.value && props.sourceId && !deleteWhole.value;
    if (replicaTarget.value) {
      const target = `/api/files/${encodeURIComponent(props.id)}/replicas/${encodeURIComponent(replicaTarget.value)}`;
      await api(
        removalMode.value === "detach"
          ? `${target}/detach`
          : `${target}?includeLast=true`,
        {
          method: removalMode.value === "detach" ? "POST" : "DELETE",
          ...(removalMode.value === "detach"
            ? {
                body: JSON.stringify({
                  confirm: true,
                  includeLast: true,
                }),
              }
            : {}),
        },
      );
    } else if (sourceOnly) {
      const result = await api<import("../../../shared/api").BatchDeleteResult>(
        removalMode.value === "detach"
          ? "/api/files/batch-detach"
          : "/api/files/batch-delete",
        {
          method: "POST",
          body: JSON.stringify({
            ids: [props.id],
            confirm: true,
            sourceId: props.sourceId,
            includeLast: true,
          }),
        },
      );
      if (!result.results[0]?.accepted)
        throw new Error(errorMessage(result.results[0]?.error));
    } else {
      await api(
        "/api/files/" +
          encodeURIComponent(props.id) +
          (removalMode.value === "detach" ? "/detach" : ""),
        {
          method: removalMode.value === "detach" ? "POST" : "DELETE",
          ...(removalMode.value === "detach"
            ? { body: JSON.stringify({ confirm: true }) }
            : {}),
        },
      );
      queryClient.setQueryData<FileView>(["file", props.id], (old) =>
        old
          ? {
              ...old,
              status: removalMode.value === "detach" ? "deleted" : "deleting",
              error: null,
            }
          : old,
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
  >
    <SheetContent
      hide-close
      class="flex h-dvh w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
    >
      <header
        class="flex shrink-0 items-start gap-2 border-b px-4 py-4 sm:px-6"
      >
        <div class="min-w-0 flex-1">
          <SheetTitle class="truncate text-base" :title="file?.logicalKey">{{
            file?.logicalKey.split("/").pop() ?? t("ui.imageDetails")
          }}</SheetTitle>
          <SheetDescription class="sr-only">{{
            t("ui.imageDetails")
          }}</SheetDescription>
          <div
            v-if="file"
            class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
          >
            <span>{{
              file.mimeType
                ?.replace("image/", "")
                .replace("svg+xml", "svg")
                .toUpperCase() ?? t("ui.unknown")
            }}</span
            ><span>· {{ file.width ?? "—" }} × {{ file.height ?? "—" }}</span
            ><span>· {{ size(file.byteSize) }}</span>
            <span
              v-if="isAdmin"
              class="inline-flex min-w-0 items-center gap-1"
              :title="t('users.owner')"
              ><UserRound :size="12" class="shrink-0" /><span
                class="truncate"
                >{{ file.ownerName ?? t("users.guest") }}</span
              ></span
            >
            <span
              v-if="file.status !== 'ready'"
              class="rounded bg-muted px-1.5 py-0.5 text-foreground"
              >{{ fileStatus(file) }}</span
            >
          </div>
        </div>
        <div class="flex shrink-0 gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!canPrevious || navigating || deleting || confirming"
            :aria-label="t('images.previousImage')"
            @click="emit('previous')"
            ><ChevronLeft
          /></Button>
          <Button
            variant="ghost"
            size="icon-sm"
            :disabled="!canNext || navigating || deleting || confirming"
            :aria-label="t('images.nextImage')"
            @click="emit('next')"
            ><ChevronRight
          /></Button>
          <SheetClose as-child>
            <Button variant="ghost" size="icon-sm" :aria-label="t('ui.close')"
              ><X
            /></Button>
          </SheetClose>
        </div>
      </header>
      <div
        class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
        data-testid="detail-body"
      >
        <p v-if="navigationError" role="alert" class="error-box">
          {{ navigationError }}
        </p>
        <p v-if="detail.isPending.value" class="subtle">
          {{ t("ui.loading") }}
        </p>
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
            class="h-[clamp(12rem,32dvh,20rem)] overflow-hidden rounded-lg border"
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
            class="rounded-lg bg-muted px-4 py-8 text-center text-sm"
            role="status"
          >
            {{ fileStatus(file) }}
            <p
              v-if="file.status === 'deleting'"
              class="mt-2 text-xs text-muted-foreground"
            >
              {{ t("ui.publicAccessDisabledCleanupPending") }}
            </p>
          </div>
          <div v-if="file.ownerId !== null">
            <OrganizationEditor :files="[file]" />
          </div>
          <div
            v-if="file.status === 'blocked'"
            class="flex flex-wrap items-center gap-2 text-sm"
          >
            <span class="text-muted-foreground">{{
              t("images.blockedHint")
            }}</span
            ><Button
              v-if="isAdmin"
              variant="outline"
              size="sm"
              :loading="restoring"
              @click="restoreAccess"
              >{{ t("images.restoreAccess") }}</Button
            >
          </div>
          <p v-if="file.error" class="error-box">
            {{
              file.error === "DELETE_FAILED"
                ? t("ui.cleanupFailedCheckStorageIfRetriesKeep")
                : errorMessage(file.error)
            }}
          </p>
          <p v-if="operationError" role="alert" class="error-box">
            {{ operationError }}
          </p>
          <Button
            v-if="isAdmin && failedTaskCount"
            variant="link"
            size="sm"
            class="h-auto p-0 text-destructive"
            @click="inspectOperations"
            >{{ t("images.failedTasks", { count: failedTaskCount }) }}</Button
          >
          <AccessLinkBuilder
            v-if="file.status === 'ready'"
            :key="file.id"
            :url="file.url"
          />
          <details
            open
            class="group/information border-t pt-3"
            data-testid="file-information"
          >
            <summary
              role="button"
              class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight
                :size="14"
                class="group-open/information:rotate-90"
              />
              {{ t("images.fileInformation") }}
            </summary>
            <dl
              class="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm [&>dd]:mb-2 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-y-3 sm:[&>dd]:mb-0"
            >
              <template v-if="file.origin"
                ><dt class="text-muted-foreground">
                  {{ t("organization.origin") }}
                </dt>
                <dd>
                  {{
                    t(
                      file.origin.kind === "import"
                        ? "organization.import"
                        : "organization.upload",
                    )
                  }}
                  · {{ file.origin.userId ?? t("users.guest") }}
                </dd></template
              >
              <dt class="text-muted-foreground">{{ t("ui.logicalPath") }}</dt>
              <dd class="break-all">{{ file.logicalKey }}</dd>
              <template v-if="file.storageKey !== file.logicalKey">
                <dt class="text-muted-foreground">{{ t("ui.storagePath") }}</dt>
                <dd class="break-all">{{ file.storageKey }}</dd>
              </template>
              <dt class="text-muted-foreground">{{ t("ui.fileId") }}</dt>
              <dd class="flex min-w-0 items-start gap-2">
                <span class="min-w-0 flex-1 break-all font-mono text-xs">{{
                  file.id
                }}</span
                ><Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="t('ui.copyId')"
                  @click="copy(file.id)"
                  ><Copy
                /></Button>
              </dd>
              <dt class="text-muted-foreground">{{ t("ui.created") }}</dt>
              <dd>{{ date(file.createdAt) }}</dd>
            </dl>
          </details>
          <details
            v-if="isAdmin"
            ref="storagePanel"
            open
            class="group/storage border-t pt-3"
            data-testid="file-storage"
          >
            <summary
              role="button"
              class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight :size="14" class="group-open/storage:rotate-90" />{{
                t("ui.storage")
              }}
              <span
                class="ml-auto text-xs font-normal"
                :class="
                  replicaIssue || operations.error.value
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                "
              >
                {{
                  t("images.replicaCount", {
                    count: operations.data.value?.replicas.length ?? 0,
                  })
                }}<template v-if="replicaIssue">
                  · {{ t("images.replicaError") }}</template
                >
              </span>
            </summary>
            <div class="mt-3 space-y-3">
              <p v-if="operations.error.value" class="error-box">
                {{ errorText(operations.error.value)
                }}<Button variant="ghost" @click="operations.refetch()">{{
                  t("ui.retry")
                }}</Button>
              </p>
              <div
                v-for="replica in operations.data.value?.replicas"
                :key="replica.id"
                class="border-b py-2.5 text-sm last:border-0"
                data-testid="replica-row"
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
                    [
                      'ready',
                      'blocked',
                      'failed',
                      'delete_failed',
                      'deleting',
                    ].includes(file.status) &&
                    [
                      'ready',
                      'pending',
                      'write_failed',
                      'delete_failed',
                    ].includes(replica.status) &&
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
                  :disabled="
                    !!retrying || !!replicaRetry(replica.id)?.retryError
                  "
                  @click="retryTask(replicaRetry(replica.id)!.id)"
                  >{{ t("ui.retry") }}</Button
                >
                <p
                  v-if="replicaRetry(replica.id)?.retryError"
                  class="mt-1 text-xs text-muted-foreground"
                >
                  {{ errorMessage(replicaRetry(replica.id)?.retryError) }}
                </p>
              </div>
            </div>
          </details>
          <details
            v-if="isAdmin"
            ref="processingPanel"
            open
            class="group/processing border-t pt-3"
            data-testid="file-processing"
          >
            <summary
              role="button"
              class="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden"
            >
              <ChevronRight
                :size="14"
                class="group-open/processing:rotate-90"
              />
              {{ t("images.processing") }}
              <span
                v-if="failedTaskCount || activeTaskCount"
                class="ml-auto text-xs font-normal"
                :class="
                  failedTaskCount ? 'text-destructive' : 'text-muted-foreground'
                "
                >{{
                  failedTaskCount
                    ? t("images.failedTasks", { count: failedTaskCount })
                    : t("images.activeTasks", { count: activeTaskCount })
                }}</span
              >
            </summary>
            <div class="mt-3 space-y-3">
              <details
                v-for="task in operations.data.value?.tasks"
                :key="task.id"
                class="border-b py-2.5 text-sm last:border-0"
                :open="task.status === 'failed'"
              >
                <summary class="cursor-pointer">
                  {{ operationKinds[task.kind] }}
                  · {{ operationStatuses[task.status] ?? task.status }}
                  <span v-if="task.failedStep" :title="task.failedStep.id">
                    · {{ task.failedStep.name }}</span
                  >
                </summary>
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
              </details>
              <ProcessingResults
                v-if="file.processingResults?.length"
                :results="file.processingResults"
              />
            </div>
          </details>
        </template>
      </div>
      <footer
        v-if="
          file &&
          !['deleted', 'deleting'].includes(file.status) &&
          (isAdmin || file.status !== 'delete_failed')
        "
        class="flex shrink-0 items-center justify-between gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
        data-testid="detail-actions"
      >
        <ReplaceImage
          v-if="file.status === 'ready'"
          :file="file"
          @replaced="(id) => emit('replaced', id)"
        />
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
          @click="confirmRemoval()"
          >{{
            t(props.sourceId ? "replicas.delete" : "ui.deleteImage")
          }}</Button
        >
      </footer>
      <Dialog v-model:open="confirming"
        ><DialogContent :busy="deleting"
          ><DialogTitle>{{ removalTitle }}</DialogTitle
          ><DialogDescription class="sr-only">{{
            t(
              removalMode === "detach"
                ? "removal.detachHint"
                : "removal.deleteHint",
            )
          }}</DialogDescription>
          <DeleteScope
            v-if="isAdmin"
            :scoped="!!(props.sourceId || replicaTarget)"
            :allow-whole="!!props.sourceId && !replicaTarget"
            v-model:mode="removalMode"
            v-model:whole="deleteWhole"
            :preserve-option="false"
            :disabled="deleting"
          />
          <p v-if="!isAdmin" class="subtle">{{ t("removal.deleteHint") }}</p>
          <p v-if="deletionNeedsRetry" class="subtle">
            {{ t("removal.retryHint") }}
          </p>
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
              :disabled="deletionNeedsRetry"
              @click="remove"
              >{{
                deleting
                  ? t(
                      removalMode === "detach"
                        ? "removal.detaching"
                        : "ui.deletingNow",
                    )
                  : t(
                      removalMode === "detach"
                        ? "removal.confirmDetach"
                        : "ui.confirmDelete",
                    )
              }}</Button
            >
          </div></DialogContent
        ></Dialog
      >
    </SheetContent>
  </Sheet>
</template>
