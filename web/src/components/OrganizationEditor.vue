<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FileView, BatchDeleteResult } from "../../../shared/api";
import { api, errorText, errorMessage, queryClient } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Button } from "./ui/button";
import OrganizationPicker from "./OrganizationPicker.vue";
const props = defineProps<{ files: FileView[]; batch?: boolean }>();
const emit = defineEmits<{ saved: [] }>();
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
    if (saved && !props.batch) resetDraft();
    busy.value = false;
  }
}
</script>
<template>
  <div class="space-y-3">
    <p v-if="!sameOwner" class="subtle">{{ t("organization.sameOwner") }}</p>
    <template v-else>
      <OrganizationPicker
        v-model="tagIds"
        kind="tags"
        :owner="owner"
        :disabled="busy"
        :items="batch ? undefined : files[0]?.tags"
      />
      <OrganizationPicker
        v-model="collectionIds"
        kind="collections"
        :owner="owner"
        :disabled="busy"
        :items="batch ? undefined : files[0]?.collections"
      />
      <p v-if="files.some((file) => file.backgroundPending)" class="subtle">
        {{ t("organization.processing") }}
      </p>
      <div class="flex gap-2">
        <template v-if="batch"
          ><Button
            type="button"
            variant="outline"
            :disabled="busy || (!tagIds.length && !collectionIds.length)"
            @click="save('add')"
            >{{ t("organization.addSelected") }}</Button
          ><Button
            type="button"
            variant="outline"
            :disabled="busy || (!tagIds.length && !collectionIds.length)"
            @click="save('remove')"
            >{{ t("organization.removeSelected") }}</Button
          ></template
        ><Button v-else type="button" :loading="busy" @click="save('save')">{{
          t("ui.save")
        }}</Button>
      </div>
      <p v-if="summary" role="status" class="subtle">{{ summary }}</p>
      <p v-if="error" role="alert" class="error-box whitespace-pre-line">
        {{ error }}
      </p>
    </template>
  </div>
</template>
