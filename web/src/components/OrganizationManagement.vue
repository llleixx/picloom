<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useRoute, useRouter } from "vue-router";
import { Folder, Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
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
  target = ref<TagView | CollectionView>(),
  name = ref(""),
  description = ref(""),
  error = ref(""),
  busy = ref(false),
  deleting = ref(false);
function edit(item?: TagView | CollectionView) {
  target.value = item;
  name.value = item?.name ?? "";
  description.value = item && "description" in item ? item.description : "";
  error.value = "";
  deleting.value = false;
  editing.value = true;
}
async function save() {
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
  if (!target.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/api/${kind.value}/${target.value.id}`, { method: "DELETE" });
    editing.value = false;
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
    <div class="mb-6 flex items-center justify-between gap-3">
      <h1 class="page-heading">
        {{
          t(kind === "tags" ? "organization.tags" : "organization.collections")
        }}
      </h1>
      <Button @click="edit()"
        ><Plus />{{
          t(
            kind === "tags"
              ? "organization.newTag"
              : "organization.newCollection",
          )
        }}</Button
      >
    </div>
    <div class="mb-6 space-y-3">
      <OrganizationOwner v-model="owner" />
      <div class="flex flex-wrap gap-2">
        <Input
          v-model="search"
          class="max-w-sm"
          :placeholder="t('organization.search')"
          :aria-label="t('organization.search')"
        /><template v-if="kind === 'collections'"
          ><select
            v-model="sort"
            class="native-select"
            :aria-label="t('organization.sort')"
          >
            <option value="name">{{ t("organization.name") }}</option>
            <option value="createdAt">{{ t("ui.created") }}</option></select
          ><select
            v-model="order"
            class="native-select"
            :aria-label="t('organization.order')"
          >
            <option value="asc">{{ t("organization.asc") }}</option>
            <option value="desc">{{ t("organization.desc") }}</option>
          </select></template
        >
      </div>
    </div>
    <p v-if="list.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
    <p v-else-if="list.error.value" class="error-box">
      {{ errorText(list.error.value) }}
    </p>
    <p v-else-if="!list.data.value?.items.length" class="subtle">
      {{ t("organization.empty") }}
    </p>
    <div
      :class="
        kind === 'collections'
          ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3'
          : 'divide-y border-y'
      "
    >
      <article
        v-for="item in list.data.value?.items"
        :key="item.id"
        :class="
          kind === 'collections'
            ? 'panel overflow-hidden'
            : 'flex flex-wrap items-center gap-3 py-3'
        "
      >
        <button
          v-if="'preview' in item"
          class="block aspect-[2/1] w-full bg-muted"
          @click="browse(item)"
          :aria-label="item.name"
        >
          <ImagePreview
            v-if="item.preview"
            thumbnail
            :src="item.preview.thumbnailUrl"
            :alt="item.name"
          /><Folder v-else class="mx-auto text-muted-foreground" :size="30" />
        </button>
        <div
          :class="kind === 'collections' ? 'space-y-2 p-4' : 'min-w-0 flex-1'"
        >
          <button
            class="break-all text-left font-medium hover:underline"
            @click="browse(item)"
          >
            {{ item.name }}
          </button>
          <p
            v-if="'description' in item && item.description"
            class="line-clamp-2 whitespace-pre-line text-sm text-muted-foreground"
          >
            {{ item.description }}
          </p>
          <p v-if="'readyFileCount' in item" class="subtle">
            {{ t("organization.readyCount", { count: item.readyFileCount }) }}
          </p>
        </div>
        <div class="flex gap-2" :class="kind === 'collections' && 'px-4 pb-4'">
          <Button size="sm" variant="outline" @click="edit(item)">{{
            t("ui.edit")
          }}</Button
          ><Button size="sm" variant="ghost" @click="copy(item.id)">{{
            t("organization.copyId")
          }}</Button>
        </div>
      </article>
    </div>
    <div
      v-if="(list.data.value?.total ?? 0) > 24"
      class="mt-5 flex items-center justify-between"
    >
      <Button
        variant="outline"
        :disabled="offset === 0"
        @click="offset -= 24"
        >{{ t("organization.previous") }}</Button
      ><span class="subtle"
        >{{ offset + 1 }}–{{ offset + (list.data.value?.items.length ?? 0) }} /
        {{ list.data.value?.total }}</span
      ><Button
        variant="outline"
        :disabled="offset + 24 >= (list.data.value?.total ?? 0)"
        @click="offset += 24"
        >{{ t("organization.next") }}</Button
      >
    </div>
    <Dialog v-model:open="editing"
      ><DialogContent :busy="busy"
        ><DialogTitle>{{
          t(
            target
              ? "organization.edit"
              : kind === "tags"
                ? "organization.newTag"
                : "organization.newCollection",
          )
        }}</DialogTitle
        ><DialogDescription>{{ t("organization.logical") }}</DialogDescription>
        <form class="space-y-4" @submit.prevent="save">
          <label class="field"
            >{{ t("organization.name")
            }}<Input v-model="name" required :disabled="busy" /></label
          ><label v-if="kind === 'collections'" class="field"
            >{{ t("organization.description")
            }}<textarea
              v-model="description"
              rows="3"
              class="native-select w-full"
              :disabled="busy"
            />
          </label>
          <p v-if="deleting" class="subtle">
            {{ t("organization.deleteHint") }}
          </p>
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
          <div class="flex flex-wrap justify-end gap-2">
            <Button
              v-if="target && !deleting"
              type="button"
              variant="ghost"
              :disabled="busy"
              @click="deleting = true"
              >{{ t("ui.delete") }}</Button
            ><Button
              v-if="deleting"
              type="button"
              variant="destructive"
              :loading="busy"
              @click="remove"
              >{{ t("ui.confirmDelete") }}</Button
            ><Button
              type="button"
              variant="outline"
              :disabled="busy"
              @click="editing = false"
              >{{ t("ui.cancel") }}</Button
            ><Button type="submit" :loading="busy">{{ t("ui.save") }}</Button>
          </div>
        </form></DialogContent
      ></Dialog
    >
  </section>
</template>
