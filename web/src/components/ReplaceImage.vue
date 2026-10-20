<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { FileView, UploadProfileView } from "../../../shared/api";
import { api, errorText, session } from "@/lib/api";
import { enqueue, uploads } from "@/lib/uploads";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
const props = defineProps<{ file: FileView }>();
const emit = defineEmits<{ replaced: [id: string] }>();
const open = ref(false),
  selected = ref(props.file.uploadProfileId ?? ""),
  chosen = ref<File>(),
  batch = ref("");
const profiles = useQuery({
  queryKey: computed(() => ["profiles", session.value?.user.id ?? "guest"]),
  queryFn: () => api<UploadProfileView[]>("/api/upload-profiles"),
  enabled: open,
});
const profile = computed(() =>
  profiles.data.value?.find((p) => p.id === selected.value && p.available),
);
const item = computed(() =>
  uploads.find((item) => item.batchId === batch.value),
);
const busy = computed(
  () =>
    !!item.value &&
    ["queued", "uploading", "processing"].includes(item.value.status),
);
watch(
  () => item.value?.result,
  (result) => {
    if (result) {
      open.value = false;
      emit("replaced", result.id);
    }
  },
);
function submit() {
  if (chosen.value && profile.value && !busy.value)
    batch.value = enqueue([chosen.value], profile.value, props.file.id);
}
</script>
<template>
  <Button
    variant="outline"
    class="w-36"
    :disabled="file.backgroundPending"
    @click="open = true"
    >{{ t("images.replace") }}</Button
  >
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!busy) open = value;
      }
    "
  >
    <DialogContent :busy="busy">
      <DialogTitle>{{ t("images.replace") }}</DialogTitle>
      <DialogDescription>{{ t("images.replaceHint") }}</DialogDescription>
      <label class="field"
        >{{ t("ui.uploadProfile") }}
        <select v-model="selected" class="native-select" :disabled="busy">
          <option value="" disabled>{{ t("ui.selectAProfile") }}</option>
          <option
            v-for="p in profiles.data.value"
            :key="p.id"
            :value="p.id"
            :disabled="!p.available"
          >
            {{ p.name }}
          </option>
        </select>
      </label>
      <input
        type="file"
        accept="image/*"
        :aria-label="t('ui.chooseFiles')"
        :disabled="busy"
        @change="chosen = ($event.target as HTMLInputElement).files?.[0]"
      />
      <p v-if="profiles.error.value" class="error-box">
        {{ errorText(profiles.error.value) }}
      </p>
      <p v-if="item?.error" class="error-box">
        {{ item.error }} {{ t("images.replaceFailure") }}
      </p>
      <p v-if="busy" class="subtle">
        {{ t("images.replacing") }} {{ item?.progress }}%
      </p>
      <div class="flex justify-end gap-2">
        <Button variant="outline" :disabled="busy" @click="open = false">{{
          t("ui.cancel")
        }}</Button>
        <Button :disabled="busy || !chosen || !profile" @click="submit">{{
          t("images.replace")
        }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
