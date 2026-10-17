<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { t, locale } from "@/lib/i18n";
import { api, ApiError, errorText, queryClient, notify } from "@/lib/api";
import { localizePlugin } from "../../../shared/plugin-localization";
import type {
  PipelineView,
  PipelineKind,
  PluginSummary,
} from "../../../shared/config";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PipelineEditor from "./PipelineEditor.vue";
const open = defineModel<boolean>({ required: true });
const props = defineProps<{ id?: string; kind?: PipelineKind }>();
const emit = defineEmits<{ saved: [pipeline: PipelineView] }>();
const form = ref<PipelineView>();
const conflict = ref(false);
const fieldErrors = ref<Array<{ path: string; message: string }>>([]);
const busy = ref(false),
  error = ref("");
const plugins = useQuery({
  queryKey: ["plugins"],
  queryFn: ({ signal }) => api<PluginSummary[]>("/api/plugins", { signal }),
  select: computed(() => {
    const language = locale.value;
    return (items: PluginSummary[]) =>
      items.map((item) => localizePlugin(item, language));
  }),
});
async function load() {
  conflict.value = false;
  fieldErrors.value = [];
  busy.value = true;
  error.value = "";
  form.value = undefined;
  try {
    form.value = props.id
      ? await api<PipelineView>("/api/pipelines/" + props.id)
      : {
          id: "",
          name: "",
          kind: props.kind ?? "upload",
          configVersion: 0,
          steps: [],
          references: [],
        };
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
watch(open, (value) => {
  if (value) void load();
});
async function save() {
  if (busy.value) return;
  fieldErrors.value = [];
  if (!form.value) return;
  busy.value = true;
  error.value = "";
  try {
    const p = form.value;
    const saved = await api<PipelineView>(
      "/api/pipelines" + (p.id ? "/" + p.id : ""),
      {
        method: p.id ? "PUT" : "POST",
        body: JSON.stringify({ ...p, expectedVersion: p.configVersion }),
      },
    );
    form.value = saved;
    await Promise.all(
      ["pipelines", "profiles"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
    emit("saved", saved);
    if (saved.steps.some((s) => !s.ready)) {
      error.value = t("ui.savedButSomePluginsFailedToInitialize");
      return;
    }
    notify(t("ui.saved"));
    open.value = false;
  } catch (e) {
    error.value = errorText(e);
    if (e instanceof ApiError) fieldErrors.value = e.fields;
    if (e instanceof ApiError && e.code === "CONFLICT") {
      conflict.value = true;
      error.value += t("ui.yourDraftIsPreservedReloadBeforeSaving");
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Sheet v-model:open="open"
    ><SheetContent
      side="right"
      :busy="busy"
      class="flex w-full flex-col overflow-hidden p-0 sm:max-w-4xl"
    >
      <div class="shrink-0 px-6 pt-6 pr-12">
        <SheetTitle>{{
          props.id ? t("ui.editPipeline") : t("pipelines.create")
        }}</SheetTitle>
        <SheetDescription>{{
          form?.kind === "access"
            ? t("pipelines.global")
            : t("pipelines.shared")
        }}</SheetDescription>
      </div>
      <div v-if="plugins.error.value" role="alert" class="error-box mx-6 mt-4">
        {{ errorText(plugins.error.value)
        }}<Button type="button" variant="ghost" @click="plugins.refetch()">{{
          t("ui.retry")
        }}</Button>
      </div>
      <form
        v-if="form"
        @submit.prevent="save"
        class="flex min-h-0 flex-1 flex-col"
      >
        <div class="editor-body">
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="field"
              >{{ t("pipelines.name")
              }}<Input v-model="form.name" required maxlength="100"
            /></label>
            <label class="field"
              >{{ t("pipelines.kind")
              }}<select
                v-model="form.kind"
                :aria-label="t('pipelines.kind')"
                :disabled="!!form.id || !!props.kind || !!form.steps.length"
                class="native-select"
              >
                <option value="upload">{{ t("pipelines.upload") }}</option>
                <option value="post_save">
                  {{ t("pipelines.post_save") }}
                </option>
                <option v-if="form.kind === 'access'" value="access">
                  {{ t("pipelines.access") }}
                </option>
              </select></label
            >
          </div>
          <p v-if="form.references.length" class="subtle">
            {{
              t("pipelines.usedBy", {
                names: form.references.map((r) => r.name).join(", "),
              })
            }}
          </p>
          <PipelineEditor
            :key="form.kind"
            v-model="form.steps"
            :plugins="plugins.data.value ?? []"
            :stage="form.kind"
            :errors="fieldErrors"
          />
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        </div>
        <div class="editor-footer">
          <Button
            type="button"
            variant="outline"
            :disabled="busy"
            @click="open = false"
            >{{ t("ui.cancel") }}</Button
          >
          <Button type="submit" :loading="busy">{{
            busy ? t("ui.saving") : t("ui.save")
          }}</Button>
          <Button
            v-if="conflict"
            type="button"
            variant="outline"
            :disabled="busy"
            @click="load"
            >{{ t("ui.reload") }}</Button
          >
        </div>
      </form>
      <div v-else-if="error" role="alert" class="error-box">
        {{ error }}
        <Button type="button" variant="ghost" :disabled="busy" @click="load">{{
          t("ui.retry")
        }}</Button>
      </div>
      <p v-else class="subtle">{{ t("ui.loading") }}</p>
    </SheetContent></Sheet
  >
</template>
