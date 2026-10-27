<script setup lang="ts">
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, errorText, queryClient, notify } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ActionMenu from "@/components/ActionMenu.vue";
import ActionMenuItem from "@/components/ActionMenuItem.vue";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import PipelineSheet from "@/components/PipelineSheet.vue";
import type { PipelineView } from "../../../shared/config";
const pipelines = useQuery({
  queryKey: ["pipelines"],
  queryFn: ({ signal }) => api<PipelineView[]>("/api/pipelines", { signal }),
});
const groups = computed(() =>
  (["access", "upload", "post_save"] as const)
    .map((kind) => ({
      kind,
      label: t(`pipelines.group.${kind}`),
      items: (pipelines.data.value ?? []).filter(
        (pipeline) => pipeline.kind === kind,
      ),
    }))
    .filter((group) => group.items.length),
);
const editing = ref(false),
  editId = ref<string>(),
  deleting = ref<PipelineView>(),
  error = ref(""),
  busy = ref(false);
function edit(id?: string) {
  editId.value = id;
  editing.value = true;
}
async function duplicate(p: PipelineView) {
  busy.value = true;
  error.value = "";
  try {
    const copy = await api<PipelineView>(`/api/pipelines/${p.id}/duplicate`, {
      method: "POST",
    });
    await queryClient.invalidateQueries({ queryKey: ["pipelines"] });
    edit(copy.id);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  if (!deleting.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/pipelines/" + deleting.value.id, { method: "DELETE" });
    deleting.value = undefined;
    await queryClient.invalidateQueries({ queryKey: ["pipelines"] });
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
    <div class="page-header">
      <h1 class="page-heading">{{ t("pipelines.title") }}</h1>
      <Button @click="edit()"><Plus />{{ t("ui.create") }}</Button>
    </div>
    <p v-if="pipelines.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
    <div v-if="error || pipelines.error.value" role="alert" class="error-box">
      {{ error || errorText(pipelines.error.value) }}
      <Button
        v-if="pipelines.error.value"
        variant="ghost"
        size="sm"
        @click="pipelines.refetch()"
        >{{ t("ui.retry") }}</Button
      >
    </div>
    <p
      v-if="
        !pipelines.isPending.value &&
        !pipelines.error.value &&
        !pipelines.data.value?.length
      "
      class="subtle py-16 text-center"
    >
      {{ t("configuration.empty") }}
    </p>
    <div class="space-y-7">
      <section
        v-for="group in groups"
        :key="group.kind"
        :aria-labelledby="'pipelines-' + group.kind"
      >
        <h2
          :id="'pipelines-' + group.kind"
          class="section-heading mb-3 flex items-center gap-3"
        >
          {{ group.label
          }}<span class="text-sm font-normal text-muted-foreground">{{
            group.items.length
          }}</span>
        </h2>
        <div class="divide-y border-y">
          <article
            v-for="p in group.items"
            :key="p.id"
            class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
          >
            <div class="min-w-0 flex-1">
              <h3 class="break-words font-medium">{{ p.name }}</h3>
              <p class="mt-1 subtle">
                {{
                  p.steps.length === 1
                    ? t("pipelines.oneStep")
                    : t("pipelines.summary", { count: p.steps.length })
                }}
              </p>
              <p class="mt-1 break-words text-xs text-muted-foreground">
                {{
                  p.kind === "access"
                    ? t("pipelines.global")
                    : p.references.length
                      ? t("pipelines.usedBy", {
                          names: p.references.map((r) => r.name).join(", "),
                        })
                      : t("pipelines.unused")
                }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2 sm:justify-end">
              <Button size="sm" variant="outline" @click="edit(p.id)">{{
                t("ui.edit")
              }}</Button>
              <ActionMenu
                v-if="p.kind !== 'access'"
                :label="t('ui.moreActions', { name: p.name })"
              >
                <ActionMenuItem :disabled="busy" @select="duplicate(p)">{{
                  t("pipelines.duplicate")
                }}</ActionMenuItem>
                <ActionMenuItem
                  destructive
                  separator
                  :disabled="busy || !!p.references.length"
                  :description="
                    p.references.length
                      ? t('pipelines.usedBy', {
                          names: p.references.map((r) => r.name).join(', '),
                        })
                      : undefined
                  "
                  @select="
                    deleting = p;
                    error = '';
                  "
                  >{{ t("ui.delete") }}</ActionMenuItem
                >
              </ActionMenu>
            </div>
          </article>
        </div>
      </section>
    </div>
    <PipelineSheet v-model="editing" :id="editId" />
    <Dialog
      :open="!!deleting"
      @update:open="
        (value) => {
          if (!value) deleting = undefined;
        }
      "
      ><DialogContent :busy="busy">
        <DialogTitle>{{ t("pipelines.delete") }}</DialogTitle
        ><DialogDescription>{{ t("pipelines.deleteHint") }}</DialogDescription>
        <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button
            variant="outline"
            :disabled="busy"
            @click="deleting = undefined"
            >{{ t("ui.cancel") }}</Button
          ><Button variant="destructive" :loading="busy" @click="remove">{{
            busy ? t("ui.deletingNow") : t("ui.confirmDelete")
          }}</Button>
        </div>
      </DialogContent></Dialog
    >
  </section>
</template>
