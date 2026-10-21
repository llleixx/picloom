<script setup lang="ts">
import { t } from "@/lib/i18n";
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { api, ApiError, errorText, notify, queryClient } from "@/lib/api";
import type { InstanceView, GroupView } from "../../../shared/config";
const instances = useQuery({
  queryKey: ["sources"],
  queryFn: ({ signal }) =>
    api<InstanceView[]>("/api/storage-sources", { signal }),
});
const groups = useQuery({
  queryKey: ["groups"],
  queryFn: ({ signal }) => api<GroupView[]>("/api/storage-groups", { signal }),
});
const conflict = ref(false),
  open = ref(false),
  busy = ref(false),
  error = ref(""),
  deleting = ref("");
const fieldErrors = ref<Array<{ path: string; message: string }>>([]);
async function refresh() {
  await Promise.all(
    ["sources", "groups", "profiles", "pipelines", "plugins"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
const rows = computed(() => groups.data.value);
const loading = computed(() => groups.isPending.value);
const loadError = computed(() => groups.error.value ?? instances.error.value);
const group = ref<GroupView>();
const member = ref("");
async function edit(id?: string) {
  conflict.value = false;
  error.value = "";
  fieldErrors.value = [];
  open.value = true;
  busy.value = true;
  try {
    group.value = id
      ? await api<GroupView>("/api/storage-groups/" + id)
      : {
          id: "",
          name: "",
          selectionStrategy: "priority",
          redundancyCount: 0,
          configVersion: 0,
          members: [],
        };
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  error.value = "";
  fieldErrors.value = [];
  busy.value = true;
  try {
    if (!group.value) return;
    const g = group.value;
    await api("/api/storage-groups" + (g.id ? "/" + g.id : ""), {
      method: g.id ? "PUT" : "POST",
      body: JSON.stringify({ ...g, expectedVersion: g.configVersion }),
    });
    await refresh();
    open.value = false;
    notify({ key: "ui.saved" });
  } catch (e) {
    error.value = errorText(e);
    if (e instanceof ApiError) {
      fieldErrors.value = e.fields;
      if (e.code === "CONFLICT") {
        conflict.value = true;
        error.value += t("ui.yourDraftIsPreservedReloadBeforeSaving");
      }
    }
  } finally {
    busy.value = false;
  }
}
function move(n: number, d: number) {
  if (!group.value) return;
  const list = [...group.value.members],
    item = list.splice(n, 1)[0]!;
  list.splice(n + d, 0, item);
  group.value.members = list;
}
async function remove() {
  busy.value = true;
  error.value = "";
  try {
    await api("/api/storage-groups/" + deleting.value, { method: "DELETE" });
    deleting.value = "";
    await refresh();
    notify({ key: "ui.deleted" });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section>
    <div class="mb-7 flex items-start justify-between gap-4">
      <div>
        <h1 class="page-heading">{{ t("ui.storageGroups") }}</h1>
        <p class="mt-2 subtle">
          {{ t("ui.chooseStorageTargetsAndRedundancy") }}
        </p>
      </div>
      <Button @click="edit()"><Plus />{{ t("ui.create") }}</Button>
    </div>
    <div v-if="loading" class="subtle">{{ t("ui.loading") }}</div>
    <div v-else-if="loadError" class="error-box">
      {{ errorText(loadError)
      }}<Button variant="ghost" @click="refresh">{{ t("ui.retry") }}</Button>
    </div>
    <div v-else-if="!rows?.length" class="py-16 text-center subtle">
      {{ t("configuration.empty") }}
    </div>
    <div v-else class="divide-y border-y">
      <article
        v-for="item in rows"
        :key="item.id"
        class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
      >
        <div class="min-w-0 flex-1">
          <h2 class="break-words font-medium">{{ item.name }}</h2>

          <p class="mt-1 break-words text-sm text-muted-foreground">
            {{
              t("configuration.members", {
                count: item.members.length,
              })
            }}
            ·
            {{
              t("configuration.redundancy", {
                count: item.redundancyCount,
              })
            }}
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2 sm:max-w-72 sm:justify-end">
          <Button size="sm" variant="outline" @click="edit(item.id)">{{
            t("ui.edit")
          }}</Button
          ><Button
            size="sm"
            variant="ghost"
            @click="
              deleting = item.id;
              error = '';
            "
            >{{ t("ui.delete") }}</Button
          >
        </div>
      </article>
    </div>
    <p v-if="error && !open && !deleting" role="alert" class="error-box mt-4">
      {{ error }}
    </p>

    <Sheet v-model:open="open"
      ><SheetContent
        :busy="busy"
        class="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl"
        ><div class="shrink-0 px-6 pt-6 pr-12">
          <SheetTitle>{{
            t(`configuration.${group?.id ? "edit" : "create"}.groups`)
          }}</SheetTitle
          ><SheetDescription>{{
            t("ui.changesApplyToFutureRequests")
          }}</SheetDescription>
        </div>
        <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
          <div class="editor-body">
            <p class="subtle">{{ t("groups.selectionHint") }}</p>
            <template v-if="group"
              ><label class="field"
                >{{ t("ui.groupName")
                }}<Input v-model="group.name" required maxlength="100" /></label
              ><label class="field"
                >{{ t("ui.selectionStrategy")
                }}<select
                  :aria-label="t('ui.selectionStrategy')"
                  v-model="group.selectionStrategy"
                  class="native-select"
                >
                  <option value="priority">{{ t("ui.priority") }}</option>
                  <option value="weighted_random">
                    {{ t("ui.weightedRandom") }}
                  </option>
                </select></label
              ><label class="field"
                >{{ t("ui.redundantCopies")
                }}<Input
                  v-model="group.redundancyCount"
                  type="number"
                  min="0"
                  :max="Math.max(0, group.members.length - 1)"
                  required
              /></label>
              <div class="space-y-3">
                <h3 class="text-sm font-medium">
                  {{
                    t(
                      group.selectionStrategy === "priority"
                        ? "ui.memberOrder"
                        : "groups.members",
                    )
                  }}
                </h3>
                <div
                  v-for="(entry, n) in group.members"
                  :key="entry.instanceId"
                  class="border-t py-4"
                >
                  <p class="text-sm">
                    {{
                      instances.data.value?.find(
                        (i) => i.id === entry.instanceId,
                      )?.name ?? entry.instanceId
                    }}
                    {{
                      instances.data.value?.find(
                        (i) => i.id === entry.instanceId,
                      )?.ready
                        ? ""
                        : t("ui.unavailable2")
                    }}
                  </p>
                  <label
                    v-if="group.selectionStrategy === 'weighted_random'"
                    class="field mt-2"
                    >{{ t("ui.readAndUploadWeight")
                    }}<Input
                      v-model.number="entry.weight"
                      :aria-label="t('groups.memberWeight', { number: n + 1 })"
                      type="number"
                      min="0"
                      step="any"
                      required
                  /></label>
                  <div class="mt-2 flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      v-if="group.selectionStrategy === 'priority'"
                      :disabled="n === 0"
                      @click="move(n, -1)"
                      >{{ t("ui.moveUp") }}</Button
                    ><Button
                      type="button"
                      size="sm"
                      variant="outline"
                      v-if="group.selectionStrategy === 'priority'"
                      :disabled="n === group.members.length - 1"
                      @click="move(n, 1)"
                      >{{ t("ui.moveDown") }}</Button
                    ><Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      @click="group.members.splice(n, 1)"
                      >{{ t("ui.remove") }}</Button
                    >
                  </div>
                </div>
                <div class="flex gap-2">
                  <select
                    v-model="member"
                    class="native-select min-w-0 flex-1"
                    :aria-label="t('ui.storageMember')"
                  >
                    <option value="">{{ t("ui.selectAStorageSource") }}</option>
                    <option
                      v-for="i in instances.data.value?.filter(
                        (i) =>
                          i.kind === 'storage' &&
                          i.ready &&
                          !group!.members.some((m) => m.instanceId === i.id),
                      )"
                      :key="i.id"
                      :value="i.id"
                    >
                      {{ i.name }}
                    </option></select
                  ><Button
                    type="button"
                    variant="outline"
                    :disabled="!member"
                    @click="
                      group.members.push({ instanceId: member, weight: 1 });
                      member = '';
                    "
                    ><Plus />{{ t("ui.addMember") }}</Button
                  >
                </div>
              </div>
            </template>

            <div v-if="error" role="alert" class="error-box">
              {{ error }}
            </div>
          </div>
          <div class="editor-footer">
            <Button
              type="button"
              variant="outline"
              :disabled="busy"
              @click="open = false"
              >{{ t("ui.cancel") }}</Button
            >
            <Button type="submit" :loading="busy" :disabled="busy">{{
              busy ? t("ui.saving") : t("ui.save")
            }}</Button
            ><Button
              v-if="conflict"
              type="button"
              variant="outline"
              :disabled="busy"
              @click="edit(group?.id)"
              >{{ t("ui.reload") }}</Button
            >
          </div>
        </form>
      </SheetContent></Sheet
    >
    <Dialog
      :open="!!deleting"
      @update:open="
        (value) => {
          if (!value) deleting = '';
        }
      "
      ><DialogContent :busy="busy"
        ><DialogTitle>{{ t("ui.deleteConfiguration") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.existingImagesAreKeptPendingActionsMay")
        }}</DialogDescription>
        <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="deleting = ''">{{
            t("ui.cancel")
          }}</Button
          ><Button variant="destructive" :loading="busy" @click="remove">{{
            busy ? t("ui.deletingNow") : t("ui.confirmDelete")
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </section>
</template>
