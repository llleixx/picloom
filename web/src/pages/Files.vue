<script setup lang="ts">
import { t } from "@/lib/i18n";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import {
  Plus,
  Search,
  LayoutGrid,
  List,
  Image,
  ChevronLeft,
  ChevronRight,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  FileView,
  BatchDeleteResult,
  UserView,
} from "../../../shared/api";
import {
  api,
  isAdmin,
  response,
  errorText,
  errorMessage,
  copy,
  queryClient,
} from "@/lib/api";
import { date, size, statuses, fileStatus } from "@/lib/utils";
import ImagePreview from "@/components/ImagePreview.vue";
import UploadPanel from "@/components/UploadPanel.vue";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { copyFormats, copyPreferences, formatLink } from "@/lib/link-formats";
import { dateBoundary, localDate } from "@/lib/date-range";
import DeleteScope from "@/components/DeleteScope.vue";
import FileDetail from "@/components/FileDetail.vue";
const ownerSearch = ref("");
const owners = useQuery({
  queryKey: computed(() => ["users", "picker", ownerSearch.value]),
  enabled: isAdmin,
  queryFn: () =>
    api<{ items: UserView[] }>(
      "/api/users?limit=30&q=" + encodeURIComponent(ownerSearch.value),
    ),
});
const sources = useQuery({
  queryKey: ["storage-sources"],
  enabled: isAdmin,
  queryFn: () =>
    api<Array<{ id: string; name: string }>>("/api/storage-sources"),
});
const sourceId = computed(() =>
  isAdmin.value && typeof route.query.source === "string"
    ? route.query.source
    : "",
);
const deleteWhole = ref(false),
  includeLast = ref(false);
const pageSize = 24;
const route = useRoute(),
  router = useRouter(),
  uploading = ref(false);
const mode = ref(localStorage.getItem("fileView") === "list" ? "list" : "grid");
watch(mode, (value) => localStorage.setItem("fileView", value));
const page = computed(() => {
  const n = Number(route.query.page ?? 1);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
});
const status = computed(() =>
  typeof route.query.status === "string" ? route.query.status : "ready",
);
const mime = computed(() =>
  typeof route.query.mimeType === "string" ? route.query.mimeType : "",
);
const search = ref(typeof route.query.q === "string" ? route.query.q : "");
watch(
  () => route.query.q,
  (q) => (search.value = typeof q === "string" ? q : ""),
);
const params = computed(() => {
  const p = new URLSearchParams({
    limit: String(pageSize),
    offset: String((page.value - 1) * pageSize),
  });
  if (
    isAdmin.value &&
    typeof route.query.owner === "string" &&
    route.query.owner
  )
    p.set("owner", route.query.owner);
  if (sourceId.value) p.set("source", sourceId.value);
  if (status.value !== "all") p.set("status", status.value);
  if (mime.value) p.set("mimeType", mime.value);
  try {
    const from = dateBoundary(String(route.query.from ?? ""));
    const before = dateBoundary(String(route.query.to ?? ""), true);
    if (from !== undefined) p.set("createdFrom", String(from));
    if (before !== undefined) p.set("createdBefore", String(before));
  } catch {
    p.set("createdFrom", "invalid");
  }
  if (route.query.q) p.set("q", String(route.query.q));
  return p.toString();
});
const files = useQuery<{ items: FileView[]; total: number }>({
  queryKey: computed(() => ["files", params.value]),
  refetchInterval: (query) =>
    sourceId.value && query.state.data?.items.some((f) => f.backgroundPending)
      ? 2000
      : false,
  queryFn: async ({ signal }) => {
    const r = await response("/api/files?" + params.value, { signal });
    return {
      items: (await r.json()) as FileView[],
      total: Number(r.headers.get("X-Total-Count") ?? 0),
    };
  },
});
function update(values: Record<string, string | undefined>) {
  void router.push({
    query: { ...route.query, page: undefined, file: undefined, ...values },
  });
}
const selected = computed(() =>
  typeof route.query.file === "string" ? route.query.file : "",
);
const range = computed(() => String(route.query.range ?? "all"));
const from = ref(String(route.query.from ?? "")),
  to = ref(String(route.query.to ?? "")),
  dateError = ref("");
watch(
  () => [route.query.from, route.query.to],
  () => {
    from.value = String(route.query.from ?? "");
    to.value = String(route.query.to ?? "");
    dateError.value = "";
  },
);
function chooseRange(value: string) {
  if (value === "custom") {
    update({ range: value });
    return;
  }
  if (value === "all") {
    update({ range: undefined, from: undefined, to: undefined });
    return;
  }
  const end = new Date(),
    start = new Date(end);
  start.setDate(start.getDate() - (Number(value) - 1));
  update({ range: value, from: localDate(start), to: localDate(end) });
}
function applyDates() {
  try {
    const a = dateBoundary(from.value),
      b = dateBoundary(to.value, true);
    if (a !== undefined && b !== undefined && a >= b) throw new Error();
    update({
      range: "custom",
      from: from.value || undefined,
      to: to.value || undefined,
    });
    dateError.value = "";
  } catch {
    dateError.value = t("images.invalidDates");
  }
}
const checked = ref(new Map<string, FileView>()),
  bulkBusy = ref(false),
  confirmDelete = ref(false);
const failures = ref<Array<{ id: string; name: string; error: string }>>([]),
  acceptedCount = ref<number | null>(null);
const selectable = computed(
  () =>
    files.data.value?.items.filter(
      (f) => !["deleting", "deleted"].includes(f.status),
    ) ?? [],
);
const allChecked = computed(
  () =>
    !!selectable.value.length &&
    selectable.value.every((f) => checked.value.has(f.id)),
);
function toggle(file: FileView) {
  if (checked.value.has(file.id)) checked.value.delete(file.id);
  else checked.value.set(file.id, file);
}
function togglePage() {
  const remove = allChecked.value;
  for (const file of selectable.value) {
    if (remove) checked.value.delete(file.id);
    else checked.value.set(file.id, file);
  }
}
watch(
  [
    () => route.query.owner,
    () => route.query.source,
    () => status.value,
    () => mime.value,
    () => route.query.q,
    () => route.query.from,
    () => route.query.to,
  ],
  () => {
    checked.value.clear();
    failures.value = [];
    acceptedCount.value = null;
  },
);
watch(
  () => files.data.value?.items,
  (items) => {
    for (const item of items ?? [])
      if (checked.value.has(item.id)) {
        if (["deleting", "deleted"].includes(item.status))
          checked.value.delete(item.id);
        else checked.value.set(item.id, item);
      }
  },
);
watch(
  () => files.data.value,
  (data) => {
    if (data && page.value > Math.max(1, Math.ceil(data.total / pageSize)))
      update({ page: String(Math.max(1, Math.ceil(data.total / pageSize))) });
  },
);
const copyable = computed(() =>
  [...checked.value.values()].filter((f) => f.status === "ready"),
);
function copySelected() {
  void copy(
    copyable.value
      .map((f) => formatLink(f.url, copyPreferences.format))
      .join("\n"),
  );
}
async function deleteSelected() {
  if (bulkBusy.value) return;
  bulkBusy.value = true;
  failures.value = [];
  acceptedCount.value = 0;
  const targets = [...checked.value.values()];
  try {
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      try {
        const { results } = await api<BatchDeleteResult>(
          "/api/files/batch-delete",
          {
            method: "POST",
            body: JSON.stringify({
              ids: chunk.map((f) => f.id),
              ...(sourceId.value && !deleteWhole.value
                ? { sourceId: sourceId.value, includeLast: includeLast.value }
                : {}),
            }),
          },
        );
        for (const result of results) {
          if (result.accepted) {
            acceptedCount.value++;
            checked.value.delete(result.id);
            if (selected.value === result.id)
              update({ file: undefined, page: String(page.value) });
          } else
            failures.value.push({
              id: result.id,
              name: chunk.find((f) => f.id === result.id)!.logicalKey,
              error: errorMessage(result.error),
            });
        }
      } catch (e) {
        for (const file of chunk)
          failures.value.push({
            id: file.id,
            name: file.logicalKey,
            error: errorText(e),
          });
      }
    }
    confirmDelete.value = false;
    await queryClient.invalidateQueries({ queryKey: ["files"] });
    await queryClient.invalidateQueries({ queryKey: ["file"] });
  } finally {
    bulkBusy.value = false;
  }
}
const navigating = ref(false),
  navigationError = ref("");
const position = computed(
  () => files.data.value?.items.findIndex((f) => f.id === selected.value) ?? -1,
);
const canPrevious = computed(
  () => position.value >= 0 && (position.value > 0 || page.value > 1),
);
const canNext = computed(
  () =>
    position.value >= 0 &&
    (page.value - 1) * pageSize + position.value + 1 <
      (files.data.value?.total ?? 0),
);
async function navigate(direction: -1 | 1) {
  if (
    navigating.value ||
    (direction === -1 ? !canPrevious.value : !canNext.value)
  )
    return;
  navigating.value = true;
  navigationError.value = "";
  const originId = selected.value,
    originParams = params.value;
  try {
    const index = position.value + direction;
    let target = files.data.value?.items[index],
      targetPage = page.value;
    if (!target) {
      targetPage += direction;
      const p = new URLSearchParams(params.value);
      p.set("offset", String((targetPage - 1) * pageSize));
      const items = await api<FileView[]>("/api/files?" + p);
      target = direction === 1 ? items[0] : items.at(-1);
    }
    if (target && selected.value === originId && params.value === originParams)
      await router.push({
        query: { ...route.query, page: String(targetPage), file: target.id },
      });
  } catch (e) {
    navigationError.value = errorText(e);
  } finally {
    navigating.value = false;
  }
}
</script>
<template>
  <section>
    <div class="mb-7 flex items-start justify-between gap-4">
      <div>
        <h1 class="page-heading">{{ t("ui.images") }}</h1>
      </div>
      <Button @click="uploading = true"
        ><Plus />{{ t("ui.uploadImages") }}</Button
      >
    </div>
    <div class="mb-6 flex flex-wrap items-center gap-3 border-b pb-5">
      <form
        class="relative min-w-40 flex-1"
        @submit.prevent="update({ q: search || undefined })"
      >
        <Search
          class="absolute left-3 top-2.5 text-muted-foreground"
          :size="17"
        /><Input
          v-model="search"
          :aria-label="t('ui.searchImages')"
          class="pl-10"
          :placeholder="t('ui.searchPathOrFileId')"
          maxlength="2048"
        />
      </form>
      <select
        :value="status"
        :aria-label="t('ui.fileStatus')"
        class="native-select"
        @change="update({ status: ($event.target as HTMLSelectElement).value })"
      >
        <option value="all">{{ t("ui.allStatuses") }}</option>
        <option v-for="(label, key) in statuses" :key="key" :value="key">
          {{ label }}
        </option>
      </select>
      <select
        :value="mime"
        :aria-label="t('ui.imageType')"
        class="native-select"
        @change="
          update({
            mimeType: ($event.target as HTMLSelectElement).value || undefined,
          })
        "
      >
        <option value="">{{ t("ui.allTypes") }}</option>
        <option
          v-for="t in ['jpeg', 'png', 'webp', 'svg+xml', 'gif', 'avif', 'tiff']"
          :key="t"
          :value="'image/' + t"
        >
          {{ t === "svg+xml" ? "SVG" : t.toUpperCase() }}
        </option>
      </select>
      <select
        :value="range"
        :aria-label="t('images.uploadedTime')"
        class="native-select"
        @change="chooseRange(($event.target as HTMLSelectElement).value)"
      >
        <option value="all">{{ t("images.anyTime") }}</option>
        <option value="1">{{ t("images.today") }}</option>
        <option value="7">{{ t("images.last7") }}</option>
        <option value="30">{{ t("images.last30") }}</option>
        <option value="custom">{{ t("images.customDates") }}</option>
      </select>
      <form
        v-if="range === 'custom'"
        class="flex w-full flex-wrap items-end gap-3"
        @submit.prevent="applyDates"
      >
        <label class="field"
          >{{ t("images.from") }}<Input v-model="from" type="date"
        /></label>
        <label class="field"
          >{{ t("images.to") }}<Input v-model="to" type="date"
        /></label>
        <Button variant="outline" type="submit">{{
          t("images.applyDates")
        }}</Button>
        <p v-if="dateError" role="alert" class="error-box">{{ dateError }}</p>
      </form>
      <div class="flex gap-1 border-l pl-3">
        <Button
          variant="ghost"
          size="icon"
          :aria-label="t('ui.gridView')"
          :aria-pressed="mode === 'grid'"
          :class="mode === 'grid' && 'bg-muted text-primary'"
          @click="mode = 'grid'"
          ><LayoutGrid /></Button
        ><Button
          variant="ghost"
          size="icon"
          :aria-label="t('ui.listView')"
          :aria-pressed="mode === 'list'"
          :class="mode === 'list' && 'bg-muted text-primary'"
          @click="mode = 'list'"
          ><List
        /></Button>
      </div>
    </div>
    <div
      v-if="selectable.length || checked.size"
      class="mb-4 flex flex-wrap items-center gap-3 text-sm"
    >
      <label class="flex items-center gap-2"
        ><input
          type="checkbox"
          class="accent-primary"
          :checked="allChecked"
          :indeterminate="
            !allChecked && selectable.some((f) => checked.has(f.id))
          "
          :disabled="bulkBusy || !selectable.length"
          @change="togglePage"
        />{{ t("images.selectPage") }}</label
      >
      <template v-if="checked.size">
        <span>{{ t("images.selectedCount", { count: checked.size }) }}</span>
        <select
          v-model="copyPreferences.format"
          :aria-label="t('uploads.copyFormat')"
          class="native-select"
        >
          <option v-for="format in copyFormats" :key="format" :value="format">
            {{ format }}
          </option>
        </select>
        <Button
          variant="outline"
          :disabled="
            !copyable.length || copyable.length !== checked.size || bulkBusy
          "
          @click="copySelected"
          >{{ t("images.copySelected") }}</Button
        >
        <Button
          variant="outline"
          :disabled="bulkBusy"
          @click="
            deleteWhole = false;
            includeLast = false;
            confirmDelete = true;
          "
          >{{ t("images.deleteSelected") }}</Button
        >
        <Button variant="ghost" :disabled="bulkBusy" @click="checked.clear()">{{
          t("images.clearSelection")
        }}</Button>
        <p v-if="copyable.length !== checked.size" class="subtle">
          {{ t("images.copyReadyOnly") }}
        </p>
      </template>
    </div>
    <div v-if="isAdmin" class="mb-4 flex flex-wrap gap-3">
      <select
        :value="sourceId"
        :aria-label="t('replicas.source')"
        class="native-select"
        @change="
          update({
            source: ($event.target as HTMLSelectElement).value,
            page: '1',
          })
        "
      >
        <option value="">{{ t("replicas.allSources") }}</option>
        <option
          v-for="source in sources.data.value"
          :key="source.id"
          :value="source.id"
        >
          {{ source.name }}
        </option>
      </select>
      <select
        :value="route.query.owner ?? ''"
        :aria-label="t('users.uploadedBy')"
        class="native-select"
        @change="
          update({
            owner: ($event.target as HTMLSelectElement).value,
            page: '1',
          })
        "
      >
        <option value="">{{ t("users.allImages") }}</option>
        <option value="me">{{ t("users.myImages") }}</option>
        <option value="guest">{{ t("users.guest") }}</option>
        <option
          v-if="
            route.query.owner &&
            !['me', 'guest'].includes(String(route.query.owner)) &&
            !owners.data.value?.items.some((u) => u.id === route.query.owner)
          "
          :value="route.query.owner"
        >
          {{ t("users.selectUser") }}
        </option>
        <optgroup :label="t('users.title')">
          <option
            v-for="owner in owners.data.value?.items"
            :key="owner.id"
            :value="owner.id"
          >
            {{ owner.username }}
          </option>
        </optgroup>
      </select>
      <Input
        v-model="ownerSearch"
        class="max-w-56"
        :aria-label="t('users.search')"
        :placeholder="t('users.search')"
      />
    </div>
    <div v-if="acceptedCount !== null" class="mb-4 space-y-2" role="status">
      <p class="subtle">
        {{
          t("images.deleteSummary", {
            accepted: acceptedCount,
            failed: failures.length,
          })
        }}
      </p>
      <ul v-if="failures.length" class="space-y-1 text-sm">
        <li v-for="failure in failures" :key="failure.id" class="break-all">
          {{ failure.name }}: {{ failure.error }}
        </li>
      </ul>
    </div>
    <div v-if="files.isPending.value" role="status" class="image-grid">
      <div
        v-for="n in 8"
        :key="n"
        class="h-56 animate-pulse rounded-xl bg-muted"
      />
      <span class="sr-only">{{ t("ui.loadingImages") }}</span>
    </div>
    <div v-else-if="files.error.value" role="alert" class="error-box">
      {{ errorText(files.error.value)
      }}<Button variant="ghost" @click="files.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <div
      v-else-if="!files.data.value?.items.length"
      class="flex min-h-80 flex-col items-center justify-center gap-4 px-8 py-16 text-center"
    >
      <span class="rounded-2xl bg-muted p-4"
        ><Image :size="30" class="text-muted-foreground"
      /></span>
      <h2 class="text-lg font-medium">{{ t("ui.noImagesFound") }}</h2>
      <p class="subtle">{{ t("ui.uploadAnImageOrAdjustYourFilters") }}</p>
      <Button variant="outline" @click="uploading = true"
        ><Plus />{{ t("ui.uploadImages") }}</Button
      >
    </div>
    <div v-else :class="mode === 'grid' ? 'image-grid' : 'divide-y border-y'">
      <article
        v-for="file in files.data.value.items"
        :key="file.id"
        class="group relative overflow-hidden"
        :class="
          mode === 'grid'
            ? 'panel transition-shadow hover:shadow-md'
            : 'flex items-center gap-4 p-3'
        "
        data-testid="file-card"
      >
        <input
          type="checkbox"
          class="z-10 size-4 accent-primary"
          :class="mode === 'grid' ? 'absolute left-3 top-3' : 'shrink-0'"
          :aria-label="t('images.selectImage', { name: file.logicalKey })"
          :checked="checked.has(file.id)"
          :disabled="bulkBusy || ['deleting', 'deleted'].includes(file.status)"
          @change="toggle(file)"
        />
        <div
          :class="
            mode === 'grid'
              ? 'aspect-[4/3]'
              : 'size-16 shrink-0 overflow-hidden rounded-md'
          "
          class="relative cursor-pointer"
          role="button"
          tabindex="0"
          :aria-label="t('images.previewLabel', { name: file.logicalKey })"
          @click="update({ file: file.id, page: String(page) })"
          @keydown.enter.self="update({ file: file.id, page: String(page) })"
          @keydown.space.prevent.self="
            update({ file: file.id, page: String(page) })
          "
        >
          <ImagePreview
            v-if="file.status === 'ready'"
            :src="`/api/files/${encodeURIComponent(file.id)}/thumbnail`"
            :alt="file.logicalKey"
          />
          <div
            v-else
            class="flex h-full items-center justify-center bg-muted text-xs text-muted-foreground"
          >
            {{ fileStatus(file) }}
          </div>
        </div>
        <button
          class="min-w-0 text-left focus-visible:bg-muted"
          :class="mode === 'grid' ? 'block w-full p-4' : 'flex-1 p-1'"
          @click="update({ file: file.id, page: String(page) })"
          :aria-label="t('images.openLabel', { name: file.logicalKey })"
        >
          <p class="truncate text-sm font-medium" :title="file.logicalKey">
            {{ file.logicalKey.split("/").pop() }}
          </p>
          <p class="mt-1 truncate text-[11px] text-muted-foreground">
            {{ file.logicalKey }}
          </p>
          <div
            class="mt-3 flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground"
          >
            <span
              >{{
                (
                  file.mimeType?.replace("image/", "") ?? t("ui.unknown")
                ).toUpperCase()
              }}
              <span class="mx-1">·</span> {{ size(file.byteSize) }}</span
            ><span>{{ file.width ?? "—" }} × {{ file.height ?? "—" }}</span>
          </div>
        </button>
        <span
          v-if="mode === 'list'"
          class="hidden pr-3 text-xs text-muted-foreground lg:block"
          >{{ date(file.createdAt) }}</span
        >
      </article>
    </div>
    <footer
      v-if="files.data.value"
      class="mt-6 flex items-center justify-between gap-2 text-xs text-muted-foreground"
    >
      <span>{{ t("images.total", { count: files.data.value.total }) }}</span>
      <div class="flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          :aria-label="t('ui.previousPage')"
          :disabled="page <= 1"
          @click="update({ page: String(page - 1) })"
          ><ChevronLeft /></Button
        ><span
          >{{ page }} /
          {{ Math.max(1, Math.ceil(files.data.value.total / pageSize)) }}</span
        ><Button
          variant="outline"
          size="icon"
          :aria-label="t('ui.nextPage')"
          :disabled="page * pageSize >= files.data.value.total"
          @click="update({ page: String(page + 1) })"
          ><ChevronRight
        /></Button>
      </div>
    </footer>
    <UploadPanel v-model:open="uploading" /><FileDetail
      v-if="selected"
      :key="selected"
      :id="selected"
      :source-id="sourceId"
      :can-previous="canPrevious"
      :can-next="canNext"
      :navigating="navigating"
      :navigation-error="navigationError"
      @replaced="(id) => update({ file: id })"
      @previous="navigate(-1)"
      @next="navigate(1)"
      @close="update({ file: undefined, page: String(page) })"
    />
    <Dialog
      :open="confirmDelete"
      @update:open="
        (value) => {
          if (!bulkBusy) confirmDelete = value;
        }
      "
    >
      <DialogContent :busy="bulkBusy"
        ><DialogTitle>{{ t("images.deleteSelected") }}</DialogTitle
        ><DialogDescription>{{
          t("images.confirmBatchDelete", { count: checked.size })
        }}</DialogDescription>
        <DeleteScope
          v-if="sourceId"
          v-model:whole="deleteWhole"
          v-model:include-last="includeLast"
        />
        <div class="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            :disabled="bulkBusy"
            @click="confirmDelete = false"
            >{{ t("ui.cancel") }}</Button
          ><Button
            variant="destructive"
            :loading="bulkBusy"
            @click="deleteSelected"
            >{{ t("images.deleteSelected") }}</Button
          >
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.image-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 1.25rem;
}
</style>
