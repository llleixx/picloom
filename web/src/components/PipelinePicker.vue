<script setup lang="ts">
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, errorText } from "@/lib/api";
import { t, locale } from "@/lib/i18n";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import PipelineSheet from "./PipelineSheet.vue";
import { localizePlugin } from "../../../shared/plugin-localization";
import type { PluginSummary, PipelineView } from "../../../shared/config";
const model = defineModel<string | null>({ required: true });
const props = defineProps<{ kind: "upload" | "post_save" }>();
const pipelines = useQuery({
  queryKey: ["pipelines"],
  queryFn: ({ signal }) => api<PipelineView[]>("/api/pipelines", { signal }),
});
const plugins = useQuery({
  queryKey: ["plugins"],
  queryFn: ({ signal }) => api<PluginSummary[]>("/api/plugins", { signal }),
  select: computed(() => {
    const language = locale.value;
    return (items: PluginSummary[]) =>
      items.map((item) => localizePlugin(item, language));
  }),
});
const selected = computed(() =>
  pipelines.data.value?.find((p) => p.id === model.value),
);
const editing = ref(false),
  editId = ref<string>();
function edit(id?: string) {
  editId.value = id;
  editing.value = true;
}
</script>
<template>
  <div class="space-y-2 border-t pt-4">
    <label class="field"
      >{{ t(`pipelines.${kind}`) }}
      <select
        :aria-label="t(`pipelines.${kind}`)"
        v-model="model"
        class="native-select"
        :disabled="pipelines.isPending.value"
      >
        <option :value="null">{{ t("pipelines.none") }}</option>
        <option
          v-for="p in pipelines.data.value?.filter(
            (p) => p.kind === props.kind,
          )"
          :key="p.id"
          :value="p.id"
        >
          {{ p.name }}
        </option>
        <option v-if="model && !selected" :value="model">
          {{ t("pipelines.unavailable") }}
        </option>
      </select>
    </label>
    <p v-if="selected" class="subtle">
      {{
        selected.steps.length === 1
          ? t("pipelines.oneStep")
          : t("pipelines.summary", { count: selected.steps.length })
      }}
      ·
      {{
        selected.steps
          .map(
            (s) =>
              plugins.data.value?.find(
                (p) => p.id === s.pluginId && p.version === s.version,
              )?.name ?? s.pluginId,
          )
          .join(" → ")
      }}
    </p>
    <div v-if="pipelines.error.value" role="alert" class="error-box">
      {{ errorText(pipelines.error.value)
      }}<Button type="button" variant="ghost" @click="pipelines.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <div class="flex gap-2">
      <Button type="button" variant="outline" size="sm" @click="edit()"
        ><Plus />{{ t("pipelines.new") }}</Button
      >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="!selected"
        @click="edit(model!)"
        >{{ t("ui.edit") }}</Button
      >
    </div>
    <PipelineSheet
      v-model="editing"
      :id="editId"
      :kind="kind"
      @saved="model = $event.id"
    />
  </div>
</template>
