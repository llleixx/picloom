<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FileView, BatchDeleteResult } from "../../../shared/api";
import { api, errorText, errorMessage, queryClient } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import OrganizationPicker from "./OrganizationPicker.vue";
import UploadOptions from "../../../themes/default/src/UploadOptions.vue";
import { Tag, Folder } from "lucide-vue-next";
const props = defineProps<{ files: FileView[]; batch?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
const editing = ref(false),
  initialKind = ref<"tags" | "collections">();
const tagPicker = ref<InstanceType<typeof OrganizationPicker>>(),
  collectionPicker = ref<InstanceType<typeof OrganizationPicker>>();
function startEditing(kind?: "tags" | "collections") {
  resetDraft();
  error.value = "";
  summary.value = "";
  initialKind.value = kind;
  editing.value = true;
}
function cancel() {
  resetDraft();
  editing.value = false;
  error.value = "";
  summary.value = "";
}
const tagIds = ref<string[]>([]),
  collectionIds = ref<string[]>([]),
  busy = ref(false),
  error = ref(""),
  summary = ref("");
const owner = computed(() => props.files[0]?.ownerId ?? undefined);
const sameOwner = computed(
  () =>
    props.files.length > 0 &&
    owner.value !== undefined &&
    props.files.every((file) => file.ownerId === owner.value),
);
const baseline = ref({ tagIds: [] as string[], collectionIds: [] as string[] });
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
const dirty = computed(
  () =>
    !sameIds(tagIds.value, baseline.value.tagIds) ||
    !sameIds(collectionIds.value, baseline.value.collectionIds),
);
function resetDraft() {
  baseline.value = {
    tagIds: props.files[0]?.tags.map((item) => item.id) ?? [],
    collectionIds: props.files[0]?.collections?.map((item) => item.id) ?? [],
  };
  tagIds.value = [...baseline.value.tagIds];
  collectionIds.value = [...baseline.value.collectionIds];
}
watch(
  () => props.files,
  (files, previous) => {
    if (
      !props.batch &&
      (files[0]?.id !== previous?.[0]?.id || (!busy.value && !dirty.value))
    )
      resetDraft();
  },
  { immediate: true },
);
async function save(mode: "save" | "add" | "remove") {
  if (busy.value || !sameOwner.value) return;
  busy.value = true;
  error.value = "";
  summary.value = "";
  const failures: string[] = [];
  let saved = false;
  try {
    for (const [kind, ids, initial] of [
      ["tags", tagIds.value, baseline.value.tagIds],
      ["collections", collectionIds.value, baseline.value.collectionIds],
    ] as const) {
      const add =
        mode === "remove"
          ? []
          : ids.filter((id) => mode === "add" || !initial.includes(id));
      const remove =
        mode === "add"
          ? []
          : mode === "remove"
            ? ids
            : initial.filter((id) => !ids.includes(id));
      if (!add.length && !remove.length) continue;
      for (let i = 0; i < props.files.length; i += 100) {
        const result = await api<BatchDeleteResult>(
          `/api/files/batch-${kind}`,
          {
            method: "POST",
            body: JSON.stringify({
              ids: props.files.slice(i, i + 100).map((file) => file.id),
              add,
              remove,
            }),
          },
        );
        for (const item of result.results) {
          if (!item.accepted)
            failures.push(`${item.id}: ${errorMessage(item.error)}`);
        }
      }
    }
    saved = !failures.length;
    if (saved) summary.value = t("organization.saved");
    if (failures.length) error.value = failures.join("\n");
    emit("saved");
  } catch (e) {
    error.value = errorText(e);
  } finally {
    await Promise.all(
      ["files", "file", "organization"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
    if (saved && !props.batch) {
      resetDraft();
      editing.value = false;
    }
    busy.value = false;
  }
}
</script>
<template>
  <div class="space-y-3">
    <p v-if="!sameOwner" class="subtle">{{ t("organization.sameOwner") }}</p>
    <template v-else>
      <div
        v-if="!batch && !editing"
        class="flex flex-wrap items-center gap-1.5"
      >
        <span
          v-for="tag in files[0]?.tags"
          :key="tag.id"
          class="upload-chip"
          :title="tag.name"
          ><Tag /><span class="truncate">{{ tag.name }}</span></span
        >
        <span
          v-for="collection in files[0]?.collections"
          :key="collection.id"
          class="upload-chip"
          :title="collection.name"
          ><Folder /><span class="truncate">{{ collection.name }}</span></span
        >
        <Button
          v-if="files[0]?.tags.length || files[0]?.collections?.length"
          variant="ghost"
          size="sm"
          :aria-label="t('organization.edit')"
          @click="startEditing()"
          >{{ t("ui.edit") }}</Button
        >
        <template v-else>
          <Button variant="ghost" size="sm" @click="startEditing('tags')"
            ><Tag />{{ t("organization.addTags") }}</Button
          >
          <Button variant="ghost" size="sm" @click="startEditing('collections')"
            ><Folder />{{ t("organization.addCollections") }}</Button
          >
        </template>
      </div>
      <template v-else>
        <template v-if="batch">
          <OrganizationPicker
            v-model="tagIds"
            kind="tags"
            :owner="owner"
            :disabled="busy"
          />
          <OrganizationPicker
            v-model="collectionIds"
            kind="collections"
            :owner="owner"
            :disabled="busy"
          />
        </template>
        <UploadOptions
          v-else
          :tags="tagPicker?.selectedItems ?? []"
          :collections="collectionPicker?.selectedItems ?? []"
          signed-in
          :initial-kind="initialKind"
          :t="t"
          @remove="
            (kind, id) => {
              if (!busy) {
                if (kind === 'tags')
                  tagIds = tagIds.filter((value) => value !== id);
                else
                  collectionIds = collectionIds.filter((value) => value !== id);
              }
            }
          "
        >
          <template #tags
            ><OrganizationPicker
              ref="tagPicker"
              v-model="tagIds"
              kind="tags"
              :owner="owner"
              :items="files[0]?.tags"
              :disabled="busy"
              compact
          /></template>
          <template #collections
            ><OrganizationPicker
              ref="collectionPicker"
              v-model="collectionIds"
              kind="collections"
              :owner="owner"
              :items="files[0]?.collections"
              :disabled="busy"
              compact
          /></template>
        </UploadOptions>
        <p
          v-if="files.some((file) => file.backgroundPending)"
          class="text-xs text-muted-foreground"
        >
          {{ t("organization.processing") }}
        </p>
        <div class="flex gap-2">
          <template v-if="batch">
            <Button
              type="button"
              variant="outline"
              :disabled="busy || (!tagIds.length && !collectionIds.length)"
              @click="save('add')"
              >{{ t("organization.addSelected") }}</Button
            >
            <Button
              type="button"
              variant="outline"
              :disabled="busy || (!tagIds.length && !collectionIds.length)"
              @click="save('remove')"
              >{{ t("organization.removeSelected") }}</Button
            >
          </template>
          <template v-else>
            <Button
              type="button"
              size="sm"
              :loading="busy"
              :disabled="!dirty"
              @click="save('save')"
              >{{ t("ui.save") }}</Button
            >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              :disabled="busy"
              @click="cancel"
              >{{ t("ui.cancel") }}</Button
            >
          </template>
        </div>
      </template>
      <p v-if="summary" role="status" class="text-xs text-muted-foreground">
        {{ summary }}
      </p>
      <p v-if="error" role="alert" class="error-box whitespace-pre-line">
        {{ error }}
      </p>
    </template>
  </div>
</template>
