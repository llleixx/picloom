<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { ArrowUpDown, Check, Folder, Plus, Search, Tag } from "lucide-vue-next";
import {
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItemIndicator,
} from "reka-ui";
import { Button } from "@/components/ui/button";
import ActionMenu from "@/components/ActionMenu.vue";
import ActionMenuItem from "@/components/ActionMenuItem.vue";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import OrganizationOwner from "@/components/OrganizationOwner.vue";
import ImagePreview from "@/components/ImagePreview.vue";
import {
  api,
  response,
  errorText,
  copy,
  queryClient,
  session,
} from "@/lib/api";
import { t } from "@/lib/i18n";
import type { TagView, CollectionView } from "../../../shared/organization";
const route = useRoute(),
  router = useRouter();
const props = defineProps<{ kind: "tags" | "collections" }>();
const kind = computed(() => props.kind);
const owner = ref(
  typeof route.query.owner === "string" ? route.query.owner : "me",
);
const ownerId = computed(() =>
  owner.value === "me" ? session.value?.user.id : owner.value,
);
const search = ref(""),
  offset = ref(0),
  sort = ref("name"),
  order = ref("asc");
const sortOptions = computed(() => [
  { value: "name.asc", label: t("organization.nameAscending") },
  { value: "name.desc", label: t("organization.nameDescending") },
  { value: "createdAt.desc", label: t("organization.recentlyCreated") },
  { value: "createdAt.asc", label: t("organization.earliestCreated") },
]);
const sorting = computed({
  get: () => `${sort.value}.${order.value}`,
  set: (value: string) => {
    [sort.value, order.value] = value.split(".") as [string, string];
  },
});
const sortLabel = computed(
  () => sortOptions.value.find((item) => item.value === sorting.value)?.label,
);
watch([kind, owner, search, sort, order], () => (offset.value = 0));
const list = useQuery({
  queryKey: computed(() => [
    "organization",
    kind.value,
    owner.value,
    search.value,
    offset.value,
    sort.value,
    order.value,
  ]),
  queryFn: async ({ signal }) => {
    const p = new URLSearchParams({
      q: search.value,
      limit: "24",
      offset: String(offset.value),
    });
    if (owner.value !== "me") p.set("owner", owner.value);
    if (kind.value === "collections") {
      p.set("sort", sort.value);
      p.set("order", order.value);
    }
    const res = await response(`/api/${kind.value}?${p}`, { signal });
    return {
      items: (await res.json()) as (TagView | CollectionView)[],
      total: Number(res.headers.get("X-Total-Count") ?? 0),
    };
  },
});
const editing = ref(false),
  removing = ref(false),
  target = ref<TagView | CollectionView>(),
  name = ref(""),
  description = ref(""),
  error = ref(""),
  busy = ref(false);
const createLabel = computed(() =>
  t(
    kind.value === "tags"
      ? "organization.newTag"
      : "organization.newCollection",
  ),
);
const editLabel = computed(() =>
  t(
    kind.value === "tags"
      ? "organization.renameTag"
      : "organization.editCollection",
  ),
);
const deleteLabel = computed(() =>
  t(
    kind.value === "tags"
      ? "organization.deleteTag"
      : "organization.deleteCollection",
  ),
);
function edit(item?: TagView | CollectionView) {
  target.value = item;
  name.value = item?.name ?? "";
  description.value = item && "description" in item ? item.description : "";
  error.value = "";
  editing.value = true;
}
function confirmRemoval(item: TagView | CollectionView) {
  target.value = item;
  error.value = "";
  removing.value = true;
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(
      `/api/${kind.value}${target.value ? "/" + target.value.id : ""}`,
      {
        method: target.value ? "PATCH" : "POST",
        body: JSON.stringify({
          name: name.value,
          ...(kind.value === "collections"
            ? { description: description.value }
            : {}),
          ...(!target.value ? { ownerId: ownerId.value } : {}),
        }),
      },
    );
    editing.value = false;
    await queryClient.invalidateQueries({ queryKey: ["organization"] });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!target.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/api/${kind.value}/${target.value.id}`, { method: "DELETE" });
    removing.value = false;
    await Promise.all(
      ["organization", "files", "file"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
function browse(item: TagView | CollectionView) {
  void router.push({
    path: "/app/images",
    query: {
      owner: item.ownerId,
      ...(kind.value === "tags" ? { tag: item.id } : { collection: item.id }),
    },
  });
}
</script>
<template>
  <section>
    <header class="page-header">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <h1 class="page-heading">
          {{
            t(
              kind === "tags"
                ? "organization.tags"
                : "organization.collections",
            )
          }}
        </h1>
        <OrganizationOwner
          v-model="owner"
          :mine-label="
            t(
              kind === 'tags'
                ? 'organization.myTags'
                : 'organization.myCollections',
            )
          "
        />
      </div>
      <Button class="shrink-0" :aria-label="createLabel" @click="edit()">
        <Plus />
        <span class="hidden sm:inline">{{ createLabel }}</span>
        <span class="sm:hidden">{{ t("organization.new") }}</span>
      </Button>
    </header>
    <div class="space-y-4">
      <div class="flex min-w-0 items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <Search
            :size="16"
            class="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
          />
          <Input
            v-model="search"
            class="pl-9"
            :placeholder="
              t(
                kind === 'tags'
                  ? 'organization.searchTags'
                  : 'organization.searchCollections',
              )
            "
            :aria-label="
              t(
                kind === 'tags'
                  ? 'organization.searchTags'
                  : 'organization.searchCollections',
              )
            "
          />
        </div>
        <DropdownMenuRoot v-if="kind === 'collections'">
          <DropdownMenuTrigger as-child>
            <Button
              variant="outline"
              class="shrink-0 px-3"
              :aria-label="t('organization.sort')"
            >
              <ArrowUpDown />{{ sortLabel }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              :side-offset="6"
              class="z-50 min-w-44 rounded-lg border bg-background p-1 shadow-lg"
            >
              <DropdownMenuRadioGroup
                :model-value="sorting"
                @update:model-value="sorting = String($event)"
              >
                <DropdownMenuRadioItem
                  v-for="option in sortOptions"
                  :key="option.value"
                  :value="option.value"
                  class="relative cursor-default rounded py-2 pr-3 pl-7 text-sm outline-none data-[highlighted]:bg-muted"
                >
                  <DropdownMenuItemIndicator class="absolute left-2"
                    ><Check :size="14"
                  /></DropdownMenuItemIndicator>
                  {{ option.label }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
      <p v-if="list.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
      <p v-else-if="list.error.value" role="alert" class="error-box">
        {{ errorText(list.error.value) }}
      </p>
      <p v-else-if="!list.data.value?.items.length" class="subtle">
        {{ t("organization.empty") }}
      </p>
      <div
        :class="
          kind === 'collections'
            ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3'
            : 'grid gap-x-6 md:grid-cols-2 xl:grid-cols-3'
        "
      >
        <article
          v-for="item in list.data.value?.items"
          :key="item.id"
          class="flex min-w-0 gap-2"
          :class="
            kind === 'collections'
              ? 'items-start rounded-lg border p-3 transition-colors hover:bg-muted/30'
              : 'items-center border-b py-2.5'
          "
        >
          <button
            class="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
            :aria-label="item.name"
            :title="item.name"
            @click="browse(item)"
          >
            <template v-if="'preview' in item">
              <div
                class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:size-20 [&>div]:min-h-0"
              >
                <ImagePreview
                  v-if="item.preview"
                  thumbnail
                  :src="item.preview.thumbnailUrl"
                  :alt="item.name"
                />
                <Folder v-else class="text-muted-foreground" :size="24" />
              </div>
              <div class="min-w-0 flex-1 space-y-1">
                <p class="line-clamp-2 break-words text-sm font-medium">
                  {{ item.name }}
                </p>
                <p
                  v-if="item.description"
                  class="truncate text-xs text-muted-foreground"
                >
                  {{ item.description }}
                </p>
                <p class="text-xs text-muted-foreground">
                  {{
                    t("organization.readyCount", { count: item.readyFileCount })
                  }}
                </p>
              </div>
            </template>
            <span v-else class="upload-chip max-w-full"
              ><Tag /><span class="truncate">{{ item.name }}</span></span
            >
          </button>
          <ActionMenu :label="t('ui.moreActions', { name: item.name })">
            <ActionMenuItem @select="edit(item)">{{
              editLabel
            }}</ActionMenuItem>
            <ActionMenuItem @select="copy(item.id)">{{
              t("organization.copyId")
            }}</ActionMenuItem>
            <ActionMenuItem
              destructive
              separator
              @select="confirmRemoval(item)"
              >{{ t("ui.delete") }}</ActionMenuItem
            >
          </ActionMenu>
        </article>
      </div>
      <footer
        v-if="(list.data.value?.total ?? 0) > 24"
        class="flex items-center justify-between gap-2"
      >
        <Button
          size="sm"
          variant="outline"
          :disabled="offset === 0"
          @click="offset -= 24"
          >{{ t("organization.previous") }}</Button
        >
        <span class="text-xs text-muted-foreground"
          >{{ offset + 1 }}–{{
            offset + (list.data.value?.items.length ?? 0)
          }}
          / {{ list.data.value?.total }}</span
        >
        <Button
          size="sm"
          variant="outline"
          :disabled="offset + 24 >= (list.data.value?.total ?? 0)"
          @click="offset += 24"
          >{{ t("organization.next") }}</Button
        >
      </footer>
      <Dialog v-model:open="editing">
        <DialogContent :busy="busy">
          <DialogTitle class="pr-6">{{
            target ? editLabel : createLabel
          }}</DialogTitle>
          <DialogDescription class="sr-only">{{
            t("organization.logical")
          }}</DialogDescription>
          <form class="space-y-3" @submit.prevent="save">
            <label class="field"
              >{{ t("organization.name")
              }}<Input v-model="name" required :disabled="busy"
            /></label>
            <label v-if="kind === 'collections'" class="field"
              >{{ t("organization.description")
              }}<textarea
                v-model="description"
                rows="3"
                class="native-select w-full"
                :disabled="busy"
              />
            </label>
            <p v-if="error" role="alert" class="error-box">{{ error }}</p>
            <div class="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                :disabled="busy"
                @click="editing = false"
                >{{ t("ui.cancel") }}</Button
              >
              <Button type="submit" :loading="busy">{{ t("ui.save") }}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog v-model:open="removing">
        <DialogContent :busy="busy">
          <DialogTitle class="pr-6">{{ deleteLabel }}</DialogTitle>
          <p class="break-all text-sm font-medium">{{ target?.name }}</p>
          <DialogDescription>{{
            t("organization.deleteHint")
          }}</DialogDescription>
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button
              variant="outline"
              :disabled="busy"
              @click="removing = false"
              >{{ t("ui.cancel") }}</Button
            >
            <Button variant="destructive" :loading="busy" @click="remove">{{
              t("ui.confirmDelete")
            }}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  </section>
</template>
