<script setup lang="ts">
import { ref, reactive, onBeforeUnmount } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { api, errorText, queryClient } from "@/lib/api";
import { t } from "@/lib/i18n";
import { importMimeTypes, type ImportResult } from "../../../shared/import";
import type { InstanceView } from "../../../shared/config";
const props = defineProps<{ source: InstanceView }>();
const emit = defineEmits<{ close: [] }>();
const open = ref(true),
  busy = ref(false),
  stopping = ref(false),
  complete = ref(false),
  error = ref("");
const scope = ref(""),
  publicPrefix = ref("/i/"),
  stripDirectories = ref(0),
  types = ref<string[]>([...importMimeTypes]);
const totals = reactive({
  scanned: 0,
  imported: 0,
  skipped: 0,
  conflicts: 0,
  failed: 0,
});
const issues = ref<ImportResult["issues"]>([]);
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
  stopping.value = true;
});
async function start() {
  if (busy.value) return;
  busy.value = true;
  stopping.value = false;
  complete.value = false;
  error.value = "";
  issues.value = [];
  for (const key of Object.keys(totals) as Array<keyof typeof totals>)
    totals[key] = 0;
  const options = {
    scope: scope.value,
    publicPrefix: publicPrefix.value,
    stripDirectories: stripDirectories.value,
    mimeTypes: [...types.value],
  };
  let cursor: string | undefined;
  try {
    do {
      const result = await api<ImportResult>(
        `/api/storage-sources/${props.source.id}/import`,
        {
          method: "POST",
          body: JSON.stringify({ ...options, cursor }),
        },
      );
      for (const key of Object.keys(totals) as Array<keyof typeof totals>)
        totals[key] += result[key];
      issues.value = [...issues.value, ...result.issues].slice(0, 20);
      cursor = result.nextCursor ?? undefined;
      if (!cursor) complete.value = true;
    } while (cursor && !stopping.value && !disposed);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
    await Promise.all(
      ["sources", "files", "system-status"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  }
}
function close(value: boolean) {
  if (!value && !busy.value) emit("close");
}
</script>
<template>
  <Sheet :open="open" @update:open="close"
    ><SheetContent
      :busy="busy"
      class="flex w-full flex-col overflow-hidden p-0 sm:max-w-xl"
    >
      <div class="shrink-0 px-6 pt-6 pr-12">
        <SheetTitle>{{ t("import.title") }}</SheetTitle
        ><SheetDescription>{{ source.name }}</SheetDescription>
      </div>
      <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="start">
        <div class="editor-body">
          <p class="subtle">{{ t("import.description") }}</p>
          <label class="field"
            >{{ t("import.scope")
            }}<Input
              v-model="scope"
              :disabled="busy"
              aria-describedby="import-scope-hint"
          /></label>
          <p id="import-scope-hint" class="subtle">
            {{ t("import.scopeHint") }}
          </p>
          <label class="field"
            >{{ t("ui.publicPrefix")
            }}<Input v-model="publicPrefix" :disabled="busy" required
          /></label>
          <label class="field">
            {{ t("import.stripDirectories") }}
            <Input
              v-model="stripDirectories"
              type="number"
              min="0"
              step="1"
              required
              :disabled="busy"
              aria-describedby="import-strip-hint"
            />
          </label>
          <p id="import-strip-hint" class="subtle">
            {{ t("import.stripHint") }}
          </p>
          <fieldset :disabled="busy">
            <legend class="mb-2 text-sm">{{ t("ui.allowedFormats") }}</legend>
            <label
              v-for="mime in importMimeTypes"
              :key="mime"
              class="mr-4 inline-flex gap-2 text-sm"
              ><input v-model="types" type="checkbox" :value="mime" />{{
                mime.replace("image/", "")
              }}</label
            >
          </fieldset>
          <p class="text-sm">{{ t("import.takeover") }}</p>
          <p class="subtle">{{ t("import.restart") }}</p>
          <div aria-live="polite" class="space-y-2 border-t pt-4">
            <p>{{ t("import.counts", totals) }}</p>
            <p v-if="complete" class="text-sm">{{ t("import.complete") }}</p>
            <p v-else-if="stopping && !busy" class="text-sm">
              {{ t("import.stopped") }}
            </p>
          </div>
          <ul v-if="issues.length" class="space-y-1 text-sm break-all">
            <li v-for="(item, n) in issues" :key="n">
              {{ item.logicalKey }} —
              {{
                item.code === "PATH_CONFLICT"
                  ? t("import.conflict")
                  : item.code === "PATH_TOO_SHALLOW"
                    ? t("import.pathTooShallow")
                    : t("import.invalid")
              }}
            </li>
          </ul>
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        </div>
        <div class="editor-footer">
          <Button
            v-if="busy"
            type="button"
            variant="outline"
            :disabled="stopping"
            @click="stopping = true"
            >{{ stopping ? t("import.stopping") : t("import.stop") }}</Button
          >
          <Button
            v-else
            type="button"
            variant="outline"
            @click="emit('close')"
            >{{ t("ui.close") }}</Button
          >
          <Button
            type="submit"
            :disabled="busy || !types.length"
            :loading="busy"
            >{{ t("import.start") }}</Button
          >
        </div>
      </form>
    </SheetContent></Sheet
  >
</template>
