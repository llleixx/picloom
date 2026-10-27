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
  ChevronDown,
  Check,
  X,
  Tag,
  Folder,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FileView, BatchDeleteResult } from "../../../shared/api";
import {
  api,
  isAdmin,
  response,
  errorText,
  errorMessage,
  copy,
  queryClient,
  session,
} from "@/lib/api";
import { date, size, statuses, fileStatus } from "@/lib/utils";
import ImagePreview from "@/components/ImagePreview.vue";
import ImageFilters from "@/components/ImageFilters.vue";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItemIndicator,
} from "reka-ui";
import UploadPanel from "@/components/UploadPanel.vue";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  copyFormats,
  copyPreferences,
  formatLink,
  type CopyFormat,
} from "@/lib/link-formats";
import { dateBoundary, localDate } from "@/lib/date-range";
import DeleteScope from "@/components/DeleteScope.vue";
import OrganizationOwner from "@/components/OrganizationOwner.vue";
import OrganizationPicker from "@/components/OrganizationPicker.vue";
import OrganizationEditor from "@/components/OrganizationEditor.vue";
import type { CollectionView } from "../../../shared/organization";
import FileDetail from "@/components/FileDetail.vue";
const pageSize = 24;
const route = useRoute(),
  router = useRouter(),
  uploading = ref(false);
const collectionId = computed(() =>
  typeof route.query.collection === "string" ? route.query.collection : "",
);
const collection = useQuery({
  queryKey: computed(() => ["organization", "collection", collectionId.value]),
  enabled: computed(() => !!collectionId.value),
  queryFn: () =>
    api<CollectionView>(
      "/api/collections/" + encodeURIComponent(collectionId.value),
    ),
});
type ImageScope = "mine" | "all";
const rememberedScope = ref<ImageScope>("mine");
const scopePreferenceKey = computed(
  () => `imageScope:${session.value?.user.id ?? ""}`,
);
watch(
  scopePreferenceKey,
  (key) => {
    try {
      rememberedScope.value =
        localStorage.getItem(key) === "all" ? "all" : "mine";
    } catch {
      rememberedScope.value = "mine";
    }
  },
  { immediate: true },
);
const imageScope = computed<ImageScope>(() => {
  if (!isAdmin.value) return "mine";
  if (route.query.scope === "mine" || route.query.scope === "all")
    return route.query.scope;
  if (route.query.source) return "all";
  if (typeof route.query.owner === "string" && route.query.owner)
    return ["me", session.value?.user.id].includes(route.query.owner)
      ? "mine"
      : "all";
  if (collection.data.value)
    return collection.data.value.ownerId === session.value?.user.id
      ? "mine"
      : "all";
  return rememberedScope.value;
});
const allImages = computed(() => imageScope.value === "all");
watch(
  [scopePreferenceKey, () => route.query.scope],
  ([key, scope]) => {
    if (!isAdmin.value || (scope !== "mine" && scope !== "all")) return;
    rememberedScope.value = scope;
    try {
      localStorage.setItem(key, scope);
    } catch {}
  },
  { immediate: true },
);
const imageOwner = computed({
  get: () => {
    if (!allImages.value) return "me";
    const owner = route.query.owner;
    return typeof owner === "string" && owner
      ? owner
      : (collection.data.value?.ownerId ?? "all");
  },
  set: (value: string) => {
    const mine = value === "me" || value === session.value?.user.id;
    update({
      scope: mine ? "mine" : "all",
      owner: mine || value === "all" ? undefined : value,
      source: mine ? undefined : sourceId.value || undefined,
      tag: undefined,
      tagMode: undefined,
      collection: undefined,
      untagged: undefined,
      uncollected: undefined,
    });
  },
});
const tagPicker = ref<InstanceType<typeof OrganizationPicker>>();
const sources = useQuery({
  queryKey: ["storage-sources"],
  enabled: allImages,
  queryFn: () =>
    api<Array<{ id: string; name: string }>>("/api/storage-sources"),
});
const sourceId = computed(() =>
  allImages.value && typeof route.query.source === "string"
    ? route.query.source
    : "",
);
const deleteWhole = ref(false),
  includeLast = ref(true),
  removalMode = ref<"delete" | "detach">("delete");
const canUpload = computed(
  () =>
    !collectionId.value ||
    collection.data.value?.ownerId === session.value?.user.id,
);
const filterOwner = computed(() => {
  if (!allImages.value) return undefined;
  if (collection.data.value) return collection.data.value.ownerId;
  const owner = route.query.owner;
  if (owner === "guest") return null;
  if (owner === "me") return undefined;
  return typeof owner === "string" && owner ? owner : null;
});
const tagFilters = computed({
  get: () =>
    (Array.isArray(route.query.tag)
      ? route.query.tag
      : route.query.tag
        ? [route.query.tag]
        : []
    ).filter((id): id is string => typeof id === "string"),
  set: (value) =>
    update({ tag: value.length ? value : undefined, untagged: undefined }),
});
const collectionFilter = computed({
  get: () => (collectionId.value ? [collectionId.value] : []),
  set: (value) => update({ collection: value[0], uncollected: undefined }),
});
const organizing = ref(false);
const sameOwner = computed(
  () =>
    checked.value.size > 0 &&
    [...checked.value.values()].every((file) => file.ownerId !== null) &&
    new Set([...checked.value.values()].map((file) => file.ownerId)).size === 1,
);
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
  if (isAdmin.value) {
    if (!allImages.value) p.set("owner", "me");
    else if (typeof route.query.owner === "string" && route.query.owner)
      p.set("owner", route.query.owner);
  }
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
  for (const id of tagFilters.value) p.append("tag", id);
  if (route.query.tagMode === "any") p.set("tagMode", "any");
  if (route.query.untagged === "true") p.set("untagged", "true");
  if (collectionId.value) p.set("collection", collectionId.value);
  if (route.query.uncollected === "true") p.set("uncollected", "true");
  if (route.query.sort === "size") p.set("sort", "size");
  p.set("order", route.query.order === "asc" ? "asc" : "desc");
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
function update(values: Record<string, string | string[] | undefined>) {
  void router.push({
    query: {
      ...route.query,
      ...(isAdmin.value ? { scope: imageScope.value } : {}),
      page: undefined,
      file: undefined,
      ...values,
    },
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
type FilterChip = {
  key: string;
  label: string;
  icon?: "tag" | "collection";
  remove: () => void;
};
const filterChips = computed(() => {
  const chips: FilterChip[] = [];
  if (mime.value)
    chips.push({
      key: "mime",
      label:
        mime.value === "image/svg+xml"
          ? "SVG"
          : mime.value.replace("image/", "").toUpperCase(),
      remove: () => update({ mimeType: undefined }),
    });
  if (route.query.from || route.query.to) {
    const label =
      range.value === "1"
        ? t("images.today")
        : range.value === "7"
          ? t("images.last7")
          : range.value === "30"
            ? t("images.last30")
            : `${route.query.from ?? "…"} – ${route.query.to ?? "…"}`;
    chips.push({ key: "time", label, remove: () => chooseRange("all") });
  }
  for (const id of tagFilters.value)
    chips.push({
      key: `tag:${id}`,
      icon: "tag",
      label:
        tagPicker.value?.selectedItems.find((item) => item.id === id)?.name ??
        id,
      remove: () => {
        tagFilters.value = tagFilters.value.filter((value) => value !== id);
      },
    });
  if (tagFilters.value.length > 1 && route.query.tagMode === "any")
    chips.push({
      key: "tagMode",
      label: t("organization.anyTag"),
      remove: () => update({ tagMode: undefined }),
    });
  if (collectionId.value)
    chips.push({
      key: "collection",
      icon: "collection",
      label: collection.data.value?.name ?? collectionId.value,
      remove: () => update({ collection: undefined }),
    });
  if (route.query.untagged === "true")
    chips.push({
      key: "untagged",
      label: t("organization.untagged"),
      remove: () => update({ untagged: undefined }),
    });
  if (route.query.uncollected === "true")
    chips.push({
      key: "uncollected",
      label: t("organization.uncollected"),
      remove: () => update({ uncollected: undefined }),
    });
  if (sourceId.value)
    chips.push({
      key: "source",
      label: `${t("replicas.source")}: ${sources.data.value?.find((source) => source.id === sourceId.value)?.name ?? sourceId.value}`,
      remove: () => update({ source: undefined }),
    });
  if (route.query.sort === "size")
    chips.push({
      key: "size",
      label: t("statistics.largeFiles"),
      remove: () => update({ sort: undefined }),
    });
  if (route.query.order === "asc")
    chips.push({
      key: "order",
      label: t("organization.oldest"),
      remove: () => update({ order: undefined }),
    });
  return chips;
});
function resetFilters() {
  update({
    mimeType: undefined,
    range: undefined,
    from: undefined,
    to: undefined,
    tag: undefined,
    tagMode: undefined,
    collection: undefined,
    untagged: undefined,
    uncollected: undefined,
    source: undefined,
    order: undefined,
    sort: undefined,
  });
}
const checked = ref(new Map<string, FileView>()),
  bulkBusy = ref(false),
  confirmDelete = ref(false);
const failures = ref<Array<{ id: string; name: string; error: string }>>([]),
  acceptedCount = ref<number | null>(null),
  keptCount = ref(0);
const resultScope = ref({
  mode: "delete" as "delete" | "detach",
  replica: false,
  count: 0,
});
const bulkReplica = computed(() => !!sourceId.value && !deleteWhole.value);
const bulkTitle = computed(() => {
  const selection = bulkBusy.value
    ? resultScope.value
    : {
        mode: removalMode.value,
        replica: bulkReplica.value,
        count: checked.value.size,
      };
  return t(
    selection.mode === "detach"
      ? selection.replica
        ? "images.detachReplicasTitle"
        : "images.detachImagesTitle"
      : selection.replica
        ? "images.deleteReplicasTitle"
        : "images.deleteImagesTitle",
    { count: selection.count },
  );
});
const resultSummary = computed(() =>
  t(
    resultScope.value.mode === "detach"
      ? resultScope.value.replica
        ? "images.detachedReplicasSummary"
        : "images.detachedImagesSummary"
      : resultScope.value.replica
        ? "images.deletedReplicasSummary"
        : "images.deletedImagesSummary",
    {
      accepted: acceptedCount.value ?? 0,
      kept: keptCount.value,
      failed: failures.value.length,
    },
  ),
);
const selectable = computed(
  () =>
    files.data.value?.items.filter(
      (f) => !["deleting", "delete_failed", "deleted"].includes(f.status),
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
    () => imageScope.value,
    () => route.query.tag,
    () => route.query.collection,
    () => route.query.untagged,
    () => route.query.uncollected,
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
        if (["deleting", "delete_failed", "deleted"].includes(item.status))
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
function setCopyFormat(format: unknown) {
  copyPreferences.format = format as CopyFormat;
}
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
  keptCount.value = 0;
  const submission = {
    mode: removalMode.value,
    sourceId: sourceId.value && !deleteWhole.value ? sourceId.value : "",
    includeLast: includeLast.value,
  };
  resultScope.value = {
    mode: submission.mode,
    replica: !!submission.sourceId,
    count: checked.value.size,
  };
  const targets = [...checked.value.values()];
  try {
    for (let i = 0; i < targets.length; i += 100) {
      const chunk = targets.slice(i, i + 100);
      try {
        const { results } = await api<BatchDeleteResult>(
          submission.mode === "detach"
            ? "/api/files/batch-detach"
            : "/api/files/batch-delete",
          {
            method: "POST",
            body: JSON.stringify({
              ids: chunk.map((f) => f.id),
              confirm: true,
              ...(submission.sourceId
                ? {
                    sourceId: submission.sourceId,
                    includeLast: submission.includeLast,
                  }
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
          } else if (
            submission.sourceId &&
            !submission.includeLast &&
            result.error === "LAST_REPLICA"
          ) {
            keptCount.value++;
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
      <div class="min-w-0">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <h1 class="page-heading break-all">
            {{ collection.data.value?.name ?? t("ui.images") }}
          </h1>
          <OrganizationOwner
            v-model="imageOwner"
            :mine-label="t('users.myImages')"
            :all-label="t('users.allImages')"
            :aria-label="t('images.scope')"
            include-guest
          />
        </div>
        <template v-if="collection.data.value"
          ><p
            class="mt-2 max-w-xl whitespace-pre-line text-sm text-muted-foreground"
          >
            {{ collection.data.value.description }}
          </p>
          <p class="subtle">
            {{
              t("organization.readyCount", {
                count: collection.data.value.readyFileCount,
              })
            }}
          </p>
          <RouterLink
            :to="{
              path: '/app/collections',
              query: { owner: collection.data.value.ownerId },
            }"
            class="text-sm text-primary"
            >{{ t("organization.manage") }}</RouterLink
          ></template
        >
      </div>
      <Button v-if="canUpload" @click="uploading = true"
        ><Plus />{{
          t(collectionId ? "organization.uploadHere" : "ui.uploadImages")
        }}</Button
      >
    </div>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <form
        class="relative min-w-32 flex-1"
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
      <div class="order-2 flex shrink-0 items-center gap-2 sm:contents">
        <select
          :value="status"
          :aria-label="t('ui.fileStatus')"
          class="native-select order-1 max-w-36 shrink-0 px-2 text-xs shadow-none sm:text-sm"
          @change="
            update({ status: ($event.target as HTMLSelectElement).value })
          "
        >
          <option value="all">{{ t("ui.allStatuses") }}</option>
          <option
            v-for="key in [
              'ready',
              'blocked',
              'preparing',
              'failed',
              'deleting',
              'delete_failed',
            ] as const"
            :key="key"
            :value="key"
          >
            {{ statuses[key] }}
          </option>
          <option disabled>────────</option>
          <option value="attention">{{ t("statistics.attention") }}</option>
        </select>
        <div class="order-3 flex shrink-0 gap-0.5 rounded-md border p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            :aria-label="t('ui.gridView')"
            :aria-pressed="mode === 'grid'"
            :class="mode === 'grid' && 'bg-muted text-primary'"
            @click="mode = 'grid'"
            ><LayoutGrid /></Button
          ><Button
            variant="ghost"
            size="icon-sm"
            :aria-label="t('ui.listView')"
            :aria-pressed="mode === 'list'"
            :class="mode === 'list' && 'bg-muted text-primary'"
            @click="mode = 'list'"
            ><List
          /></Button>
        </div>
      </div>
      <ImageFilters :count="filterChips.length" @reset="resetFilters">
        <div class="grid grid-cols-2 gap-3">
          <label class="field"
            >{{ t("ui.imageType") }}
            <select
              :value="mime"
              :aria-label="t('ui.imageType')"
              class="native-select"
              @change="
                update({
                  mimeType:
                    ($event.target as HTMLSelectElement).value || undefined,
                })
              "
            >
              <option value="">{{ t("ui.allTypes") }}</option>
              <option
                v-for="t in [
                  'jpeg',
                  'png',
                  'webp',
                  'svg+xml',
                  'gif',
                  'avif',
                  'tiff',
                ]"
                :key="t"
                :value="'image/' + t"
              >
                {{ t === "svg+xml" ? "SVG" : t.toUpperCase() }}
              </option>
            </select>
          </label>
          <label class="field"
            >{{ t("images.uploadedTime") }}
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
          </label>
          <form
            v-if="range === 'custom'"
            class="col-span-2 grid grid-cols-2 items-end gap-3"
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
            <p v-if="dateError" role="alert" class="error-box">
              {{ dateError }}
            </p>
          </form>
          <label class="field col-span-2"
            >{{ t("organization.order")
            }}<select
              :value="
                route.query.sort === 'size'
                  ? 'size'
                  : (route.query.order ?? 'desc')
              "
              class="native-select"
              :aria-label="t('organization.order')"
              @change="
                update({
                  sort:
                    ($event.target as HTMLSelectElement).value === 'size'
                      ? 'size'
                      : undefined,
                  order:
                    ($event.target as HTMLSelectElement).value === 'asc'
                      ? 'asc'
                      : 'desc',
                })
              "
            >
              <option value="desc">{{ t("organization.newest") }}</option>
              <option value="asc">{{ t("organization.oldest") }}</option>
              <option value="size">{{ t("statistics.largeFiles") }}</option>
            </select></label
          >
        </div>
        <div v-if="filterOwner !== null" class="space-y-2">
          <details class="rounded-lg border p-2.5" name="image-organization">
            <summary
              role="button"
              class="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden"
            >
              <Tag :size="14" />{{ t("organization.addTags")
              }}<ChevronDown :size="14" class="ml-auto" />
            </summary>
            <OrganizationPicker
              ref="tagPicker"
              v-model="tagFilters"
              kind="tags"
              :owner="filterOwner"
              :create="false"
              compact
              class="mt-3"
            />
          </details>
          <details class="rounded-lg border p-2.5" name="image-organization">
            <summary
              role="button"
              class="flex cursor-pointer list-none items-center gap-2 text-sm [&::-webkit-details-marker]:hidden"
            >
              <Folder :size="14" />{{ t("organization.addCollections")
              }}<ChevronDown :size="14" class="ml-auto" />
            </summary>
            <OrganizationPicker
              v-model="collectionFilter"
              kind="collections"
              :owner="filterOwner"
              :create="false"
              :max="1"
              compact
              class="mt-3"
            />
          </details>
        </div>
        <div
          v-if="filterOwner !== null"
          class="flex flex-wrap items-center gap-3 text-xs"
        >
          <select
            :value="route.query.tagMode ?? 'all'"
            class="native-select"
            :aria-label="t('organization.tagMode')"
            @change="
              update({ tagMode: ($event.target as HTMLSelectElement).value })
            "
          >
            <option value="all">{{ t("organization.allTags") }}</option>
            <option value="any">
              {{ t("organization.anyTag") }}
            </option></select
          ><label class="flex items-center gap-2"
            ><input
              type="checkbox"
              :checked="route.query.untagged === 'true'"
              @change="
                update({
                  untagged: ($event.target as HTMLInputElement).checked
                    ? 'true'
                    : undefined,
                  tag: undefined,
                })
              "
            />{{ t("organization.untagged") }}</label
          ><label class="flex items-center gap-2"
            ><input
              type="checkbox"
              :checked="route.query.uncollected === 'true'"
              @change="
                update({
                  uncollected: ($event.target as HTMLInputElement).checked
                    ? 'true'
                    : undefined,
                  collection: undefined,
                })
              "
            />{{ t("organization.uncollected") }}</label
          >
        </div>
        <div v-if="allImages" class="space-y-3 border-t pt-4">
          <label class="field"
            >{{ t("replicas.source") }}
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
          </label>
        </div>
      </ImageFilters>
    </div>
    <div
      v-if="filterChips.length"
      class="mb-4 flex min-w-0 flex-wrap items-center gap-1.5"
    >
      <button
        v-for="chip in filterChips"
        :key="chip.key"
        type="button"
        class="upload-chip"
        :class="{ 'upload-chip-collection': chip.icon === 'collection' }"
        :title="chip.label"
        :aria-label="t('images.removeFilter', { name: chip.label })"
        @click="chip.remove()"
      >
        <Tag v-if="chip.icon === 'tag'" /><Folder
          v-else-if="chip.icon === 'collection'"
        />
        <span class="truncate">{{ chip.label }}</span
        ><X :size="12" class="shrink-0 text-muted-foreground" />
      </button>
      <Button variant="ghost" size="sm" @click="resetFilters">{{
        t("images.resetFilters")
      }}</Button>
    </div>
    <div
      v-if="selectable.length || checked.size"
      class="mb-4 flex flex-wrap items-center gap-2 border-b pb-3 text-xs"
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
        <span class="text-muted-foreground">{{
          t("images.selectedCount", { count: checked.size })
        }}</span>
        <div class="inline-flex rounded-md border">
          <Button
            variant="ghost"
            size="sm"
            class="rounded-r-none"
            :disabled="
              !copyable.length || copyable.length !== checked.size || bulkBusy
            "
            @click="copySelected"
            >{{ t("images.copySelected") }}</Button
          >
          <DropdownMenuRoot>
            <DropdownMenuTrigger as-child
              ><Button
                variant="ghost"
                size="icon-sm"
                class="rounded-l-none border-l"
                :disabled="bulkBusy"
                :aria-label="t('uploads.copyFormat')"
                ><ChevronDown /></Button
            ></DropdownMenuTrigger>
            <DropdownMenuPortal
              ><DropdownMenuContent
                align="start"
                :side-offset="6"
                class="z-50 min-w-40 rounded-lg border bg-background p-1 shadow-lg"
              >
                <DropdownMenuRadioGroup
                  :model-value="copyPreferences.format"
                  @update:model-value="setCopyFormat"
                >
                  <DropdownMenuRadioItem
                    v-for="format in copyFormats"
                    :key="format"
                    :value="format"
                    class="relative flex cursor-default items-center rounded px-7 py-2 text-sm outline-none data-[highlighted]:bg-muted"
                  >
                    <DropdownMenuItemIndicator class="absolute left-2"
                      ><Check :size="14" /></DropdownMenuItemIndicator
                    >{{ format }}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent></DropdownMenuPortal
            >
          </DropdownMenuRoot>
        </div>
        <Button
          variant="ghost"
          size="sm"
          :disabled="bulkBusy || !sameOwner"
          @click="organizing = true"
          >{{ t("organization.edit") }}</Button
        >
        <Button
          variant="ghost"
          size="sm"
          class="text-destructive hover:bg-destructive/10 hover:text-destructive"
          :disabled="bulkBusy"
          @click="
            deleteWhole = false;
            includeLast = true;
            removalMode = 'delete';
            confirmDelete = true;
          "
        >
          {{
            t(
              sourceId
                ? "images.deleteSelectedReplicas"
                : "images.deleteSelected",
            )
          }}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          :disabled="bulkBusy"
          @click="checked.clear()"
          >{{ t("images.clearSelection") }}</Button
        >
        <span v-if="!sameOwner" class="w-full text-xs text-muted-foreground">{{
          t("organization.sameOwner")
        }}</span>
        <p
          v-if="copyable.length !== checked.size"
          class="w-full text-xs text-muted-foreground"
        >
          {{ t("images.copyReadyOnly") }}
        </p>
      </template>
    </div>
    <div v-if="acceptedCount !== null" class="mb-4 space-y-2" role="status">
      <p class="subtle">
        {{ resultSummary }}
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
      <Button v-if="canUpload" variant="outline" @click="uploading = true"
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
          :disabled="
            bulkBusy ||
            ['deleting', 'delete_failed', 'deleted'].includes(file.status)
          "
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
            thumbnail
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
          :class="mode === 'grid' ? 'block w-full p-3' : 'flex-1 p-1'"
          @click="update({ file: file.id, page: String(page) })"
          :aria-label="t('images.openLabel', { name: file.logicalKey })"
        >
          <p class="truncate text-sm font-medium" :title="file.logicalKey">
            {{ file.logicalKey.split("/").pop() }}
          </p>
          <p
            v-if="
              file.status !== 'ready' || file.replicaIssue || file.postSaveIssue
            "
            class="mt-1 flex flex-wrap items-center gap-x-1 text-[11px] text-muted-foreground"
          >
            <span
              v-if="file.status !== 'ready'"
              :class="{
                'text-amber-600 dark:text-amber-400':
                  file.status === 'blocked' || file.status === 'delete_failed',
              }"
              >{{ fileStatus(file) }}</span
            >
            <span
              v-if="file.replicaIssue"
              class="text-amber-600 dark:text-amber-400"
              >{{ t("images.replicaError") }}</span
            >
            <span
              v-if="file.postSaveIssue"
              class="text-amber-600 dark:text-amber-400"
            >
              {{ t("images.postSaveFailed") }}
            </span>
          </p>
          <div
            class="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground"
          >
            <span
              v-if="allImages"
              class="max-w-28 truncate"
              :title="
                file.ownerName ??
                file.guestIp ??
                file.ownerId ??
                t('users.guest')
              "
              >{{
                file.ownerName ??
                file.guestIp ??
                file.ownerId ??
                t("users.guest")
              }}</span
            >
            <span v-if="allImages">·</span>
            <span
              >{{
                (
                  file.mimeType?.replace("image/", "") ?? t("ui.unknown")
                ).toUpperCase()
              }}
              <span class="mx-1">·</span> {{ size(file.byteSize) }}</span
            ><span>· {{ file.width ?? "—" }} × {{ file.height ?? "—" }}</span>
          </div>
          <div
            v-if="file.tags?.length || file.collections?.length"
            class="mt-2 flex min-w-0 items-center gap-1 overflow-hidden"
          >
            <span
              v-for="tag in file.tags.slice(0, 2)"
              :key="tag.id"
              class="upload-chip upload-chip-compact min-w-0 max-w-[45%]"
              :title="t('organization.tags') + ': ' + tag.name"
              ><Tag /><span class="truncate">{{ tag.name }}</span></span
            >
            <span
              v-if="file.tags.length > 2"
              class="shrink-0 text-[11px] text-muted-foreground"
              :title="
                t('organization.tags') +
                ': ' +
                file.tags
                  .slice(2)
                  .map((tag) => tag.name)
                  .join(' · ')
              "
              >+{{ file.tags.length - 2 }}</span
            >
            <span
              v-for="collection in file.collections?.slice(0, 2)"
              :key="collection.id"
              class="upload-chip upload-chip-compact upload-chip-collection min-w-0 max-w-[45%]"
              :title="t('organization.collections') + ': ' + collection.name"
              ><Folder /><span class="truncate">{{
                collection.name
              }}</span></span
            >
            <span
              v-if="file.collections && file.collections.length > 2"
              class="shrink-0 text-[11px] text-muted-foreground"
              :title="
                t('organization.collections') +
                ': ' +
                file.collections
                  .slice(2)
                  .map((collection) => collection.name)
                  .join(' · ')
              "
              >+{{ file.collections.length - 2 }}</span
            >
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
    <UploadPanel
      v-model:open="uploading"
      :collection-id="canUpload ? collectionId : undefined"
    /><FileDetail
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
    <Dialog v-model:open="organizing"
      ><DialogContent class="max-h-[90dvh] overflow-y-auto"
        ><DialogTitle>{{ t("organization.edit") }}</DialogTitle
        ><DialogDescription>{{ t("organization.batchHint") }}</DialogDescription
        ><OrganizationEditor
          :files="[...checked.values()]"
          batch /></DialogContent
    ></Dialog>
    <Dialog
      :open="confirmDelete"
      @update:open="
        (value) => {
          if (!bulkBusy) confirmDelete = value;
        }
      "
    >
      <DialogContent :busy="bulkBusy"
        ><DialogTitle>{{ bulkTitle }}</DialogTitle
        ><DialogDescription class="sr-only">{{
          t(
            removalMode === "detach"
              ? "removal.detachHint"
              : "removal.deleteHint",
          )
        }}</DialogDescription>
        <DeleteScope
          v-if="isAdmin"
          :scoped="!!sourceId"
          :allow-whole="!!sourceId"
          v-model:mode="removalMode"
          v-model:whole="deleteWhole"
          v-model:include-last="includeLast"
          :disabled="bulkBusy"
        />
        <p v-if="!isAdmin" class="subtle">{{ t("removal.deleteHint") }}</p>
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
            >{{
              bulkBusy
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
