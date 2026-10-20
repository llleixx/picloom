<script setup lang="ts">
import { ref, watch } from "vue";
import { t } from "@/lib/i18n";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import PluginConfigurationEditor from "./PluginConfigurationEditor.vue";
import type { ConfiguredStep, PluginSummary } from "../../../shared/config";
const steps = defineModel<ConfiguredStep[]>({ required: true });
const props = defineProps<{
  plugins: (PluginSummary & { name: string })[];
  stage: "upload" | "access" | "post_save";
  errors?: Array<{ path: string; message: string }>;
}>();
const selected = ref(0);
watch(
  () => steps.value,
  () => {
    selected.value = Math.min(
      selected.value,
      Math.max(0, steps.value.length - 1),
    );
  },
);
watch(
  () => props.errors,
  (errors) => {
    const index = errors
      ?.map((error) => /^\/steps\/(\d+)\/config/.exec(error.path))
      .find(Boolean)?.[1];
    if (index !== undefined) selected.value = Number(index);
  },
);
function add() {
  steps.value.push({
    pluginId: "",
    version: "",
    config: {},
    ...(props.stage === "post_save"
      ? {}
      : { onNotApplicable: "skip" as const }),
  });
  selected.value = steps.value.length - 1;
}
function move(d: number) {
  const items = [...steps.value],
    item = items.splice(selected.value, 1)[0]!;
  items.splice(selected.value + d, 0, item);
  selected.value += d;
  steps.value = items;
}
function remove() {
  steps.value.splice(selected.value, 1);
  selected.value = Math.max(
    0,
    Math.min(selected.value, steps.value.length - 1),
  );
}
</script>
<template>
  <div class="grid gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
    <div class="space-y-2">
      <button
        v-for="(step, n) in steps"
        :key="step.key ?? n"
        type="button"
        :aria-pressed="selected === n"
        class="w-full border-l-2 rounded-r-md p-3 text-left text-sm transition-colors"
        :class="
          selected === n
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-transparent hover:bg-muted/40'
        "
        @click="selected = n"
      >
        <span class="block text-xs text-muted-foreground">{{
          t("pipeline.step", { number: n + 1 })
        }}</span>
        <span class="break-words">{{
          plugins.find(
            (p) => p.id === step.pluginId && p.version === step.version,
          )?.name ??
          (step.pluginId || t("ui.selectAPlugin"))
        }}</span>
      </button>
      <Button type="button" variant="outline" size="sm" @click="add"
        ><Plus />{{ t("ui.addStep") }}</Button
      >
    </div>
    <div
      v-if="steps[selected]"
      class="min-w-0 space-y-6 border-t pt-5 md:border-t-0 md:border-l md:pl-6 md:pt-0"
    >
      <PluginConfigurationEditor
        :key="steps[selected]!.key ?? selected"
        v-model="steps[selected]!"
        :plugins="plugins"
        :kind="'processor'"
        :stage="stage"
        :errors="
          (errors ?? [])
            .filter((error) =>
              error.path.startsWith(`/steps/${selected}/config`),
            )
            .map((error) => ({
              ...error,
              path: error.path.slice(`/steps/${selected}/config`.length),
            }))
        "
        :label="t('ui.processorPlugin')"
      />
      <label v-if="stage !== 'post_save'" class="field"
        >{{ t("ui.unsupportedBehavior") }}
        <select
          v-model="steps[selected]!.onNotApplicable"
          class="native-select"
        >
          <option value="abort">{{ t("ui.stopIfUnsupported") }}</option>
          <option value="skip">{{ t("ui.skipIfUnsupported") }}</option>
        </select>
      </label>
      <div class="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          :disabled="selected === 0"
          @click="move(-1)"
          >{{ t("ui.moveUp") }}</Button
        >
        <Button
          type="button"
          size="sm"
          variant="outline"
          :disabled="selected === steps.length - 1"
          @click="move(1)"
          >{{ t("ui.moveDown") }}</Button
        >
        <Button type="button" size="sm" variant="ghost" @click="remove">{{
          t("ui.remove")
        }}</Button>
      </div>
    </div>
    <p v-else class="subtle p-4">{{ t("ui.noSteps") }}</p>
  </div>
</template>
