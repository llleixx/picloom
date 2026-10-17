<script setup lang="ts">
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { BackupView } from "../../../shared/backup";
import { api, errorText, session, clearSession } from "@/lib/api";
import { t, formatNumber } from "@/lib/i18n";
import { date } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
const props = defineProps<{ database: "sqlite" | "postgres" }>();
const available = computed(() => props.database === "sqlite");
const owner = computed(() => session.value?.user.role === "owner");
const query = useQuery({
  queryKey: ["backups"],
  enabled: computed(() => owner.value && available.value),
  queryFn: () => api<BackupView[]>("/api/system/backups"),
});
const busy = ref(false),
  error = ref(""),
  selected = ref<BackupView | null>(null),
  action = ref<"restore" | "delete">("restore"),
  fileInput = ref<HTMLInputElement>();
async function run(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
    await query.refetch();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
function create() {
  action.value = "restore";
  return run(() => api("/api/system/backups", { method: "POST" }));
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = "";
  if (!file) return;
  action.value = "restore";
  if (file.size > 5 * 1024 ** 3) {
    error.value = t("backup.limit");
    return;
  }
  await run(() =>
    api("/api/system/backups/upload", {
      method: "POST",
      body: file,
      headers: { "content-type": "application/gzip" },
    }),
  );
}
async function deleteBackup() {
  if (!selected.value) return;
  const id = selected.value.id;
  await run(async () => {
    await api(`/api/system/backups/${id}`, { method: "DELETE" });
    selected.value = null;
  });
}
async function restore() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(`/api/system/backups/${selected.value.id}/restore`, {
      method: "POST",
      headers: { "x-confirm-restore": "restore" },
    });
    clearSession();
    window.location.assign("/login");
  } catch (e) {
    error.value = errorText(e);
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="owner" class="border-t pt-6">
    <h2 class="font-medium">{{ t("backup.title") }}</h2>
    <p v-if="!available" class="subtle mt-2">{{ t("backup.unsupported") }}</p>
    <template v-else>
      <p class="subtle mt-2">{{ t("backup.hint") }}</p>
      <p class="subtle mt-2">{{ t("backup.sensitive") }}</p>
      <div class="mt-4 flex flex-wrap gap-2">
        <Button :disabled="busy" @click="create">{{
          t("backup.create")
        }}</Button>
        <Button
          variant="outline"
          :disabled="busy"
          @click="fileInput?.click()"
          >{{ t("backup.upload") }}</Button
        >
        <input
          ref="fileInput"
          type="file"
          accept=".tar.gz,application/gzip"
          class="hidden"
          :aria-label="t('backup.upload')"
          @change="upload"
        />
      </div>
      <p v-if="busy && action !== 'delete'" role="status" class="subtle mt-3">
        {{ t("backup.working") }}
      </p>
      <p v-if="error && !selected" role="alert" class="error-box mt-3">
        {{ error }}
      </p>
      <p v-if="query.isError.value" role="alert" class="error-box mt-3">
        {{ errorText(query.error.value) }}
      </p>
      <p v-if="query.data.value?.length === 0" class="subtle mt-4">
        {{ t("backup.empty") }}
      </p>
      <div class="mt-4 divide-y">
        <div
          v-for="item in query.data.value"
          :key="item.id"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <div>
            <p class="text-sm font-medium">{{ date(item.createdAt) }}</p>
            <p class="subtle">
              {{
                formatNumber(item.byteSize / 1024 ** 2, {
                  maximumFractionDigits: 1,
                })
              }}
              MiB
            </p>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" :disabled="busy" as-child
              ><a :href="`/api/system/backups/${item.id}`" download>{{
                t("backup.download")
              }}</a></Button
            >
            <Button
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="
                selected = item;
                action = 'restore';
                error = '';
              "
              >{{ t("backup.restore") }}</Button
            >
            <Button
              variant="outline"
              size="sm"
              :disabled="busy"
              @click="
                selected = item;
                action = 'delete';
                error = '';
              "
            >
              {{ t("ui.delete") }}
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        :open="!!selected"
        @update:open="
          (value) => {
            if (!value && !busy) selected = null;
          }
        "
      >
        <DialogContent :busy="busy">
          <DialogTitle>{{
            t(action === "delete" ? "backup.delete" : "backup.restore")
          }}</DialogTitle>
          <DialogDescription>{{
            t(action === "delete" ? "backup.deleteHint" : "backup.restoreHint")
          }}</DialogDescription>
          <p class="subtle">{{ selected ? date(selected.createdAt) : "" }}</p>
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
          <div class="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              :disabled="busy"
              @click="selected = null"
              >{{ t("ui.cancel") }}</Button
            >
            <Button
              variant="destructive"
              :loading="busy"
              @click="action === 'delete' ? deleteBackup() : restore()"
              >{{
                t(action === "delete" ? "ui.delete" : "backup.restore")
              }}</Button
            >
          </div>
        </DialogContent>
      </Dialog>
    </template>
  </section>
</template>
