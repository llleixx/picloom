<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { comparePluginVersions } from "@/lib/plugin-versions";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { api, ApiError, errorText, notify, queryClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import PluginConfigurationEditor from "./PluginConfigurationEditor.vue";
import type {
  PackageView,
  UpgradePreview,
  PluginView,
  PluginUsage,
  ConfiguredStep,
  InstanceView,
  ProfileEditor,
  PipelineView,
} from "../../../shared/config";
const open = defineModel<boolean>({ required: true });
const props = defineProps<{
  pluginId: string;
  name: string;
  packages: (PackageView & { name: string })[];
}>();
const emit = defineEmits<{ saved: [] }>();
const usages = ref<PluginUsage[]>([]);
const selected = ref<PluginUsage>();
const draft = ref<ConfiguredStep>();
const owner = ref<InstanceView | ProfileEditor | PipelineView>();
const busy = ref(false),
  ready = ref(false),
  error = ref("");
const fields = ref<Array<{ path: string; message: string }>>([]);
const plugins = computed(() =>
  props.packages.filter((p) => p.status === "loaded"),
);
const targets = ref<Record<string, string>>({});
const editing = ref(false);
function versions(u: PluginUsage) {
  return plugins.value
    .filter(
      (p) =>
        p.id === props.pluginId &&
        p.source === "external" &&
        comparePluginVersions(p.version, u.version) > 0 &&
        (!u.stage || p.supportedStages?.includes(u.stage)),
    )
    .sort((a, b) => comparePluginVersions(b.version, a.version));
}
const outdated = computed(() => usages.value.filter((u) => versions(u).length));
async function load() {
  targets.value = {};
  busy.value = true;
  error.value = "";
  editing.value = false;
  selected.value = undefined;
  draft.value = undefined;
  owner.value = undefined;
  try {
    usages.value = await api<PluginUsage[]>(
      `/api/plugins/${encodeURIComponent(props.pluginId)}/configurations`,
    );
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
watch(
  open,
  (value) => {
    if (value) void load();
  },
  { immediate: true },
);
async function select(u: PluginUsage) {
  busy.value = true;
  error.value = "";
  fields.value = [];
  selected.value = undefined;
  draft.value = undefined;
  owner.value = undefined;
  try {
    if (u.ownerType === "source") {
      const v = await api<InstanceView>("/api/storage-sources/" + u.ownerId);
      owner.value = v;
      draft.value = {
        key: v.id,
        pluginId: v.pluginId,
        version: v.version,
        config: v.config,
        secretPresence: v.secretPresence,
        ready: v.ready,
        error: v.error,
      };
    } else if (u.ownerType === "profile") {
      const v = await api<ProfileEditor>("/api/upload-profiles/" + u.ownerId);
      owner.value = v;
      draft.value = v.path;
    } else {
      const v = await api<PipelineView>("/api/pipelines/" + u.ownerId);
      owner.value = v;
      draft.value = v.steps.find((s) => s.key === u.key);
    }
    if (!draft.value || draft.value.key !== u.key)
      throw new Error(t("ui.yourDraftIsPreservedReloadBeforeSaving"));
    selected.value = u;
    const target = targets.value[u.key] ?? versions(u)[0]?.version;
    const preview = await api<UpgradePreview>(
      `/api/plugin-configurations/${encodeURIComponent(u.key)}/upgrade-preview`,
      {
        method: "POST",
        body: JSON.stringify({ version: target }),
      },
    );
    draft.value = { ...draft.value, ...preview.configuration, error: null };
    fields.value = preview.fields;
    let removedParams = false;
    if (u.stage && draft.value.enabledParams?.length) {
      const definition = await api<PluginView>(
        `/api/plugins/${encodeURIComponent(props.pluginId)}/versions/${encodeURIComponent(target!)}`,
      );
      if (definition.kind === "processor") {
        const allowed =
          definition.stages[u.stage]?.paramsSchema?.properties ?? {};
        removedParams = draft.value.enabledParams.some(
          (key) => !(key in (allowed as object)),
        );
      }
    }
    if (fields.value.length || removedParams) editing.value = true;
    else {
      busy.value = false;
      await save();
    }
  } catch (e) {
    error.value = errorText(e);
    draft.value = undefined;
  } finally {
    busy.value = false;
  }
}
async function save() {
  const u = selected.value,
    value = draft.value,
    savedOwner = owner.value;
  if (!u || !value?.upgrade || !savedOwner || busy.value) return;
  busy.value = true;
  error.value = "";
  fields.value = [];
  try {
    let initialized: boolean;
    if (u.ownerType === "source") {
      const saved = await api<InstanceView>(
        "/api/storage-sources/" + u.ownerId,
        {
          method: "PUT",
          body: JSON.stringify({
            ...value,
            name: savedOwner.name,
            expectedVersion: savedOwner.configVersion,
          }),
        },
      );
      initialized = saved.ready;
    } else if (u.ownerType === "profile") {
      const saved = await api<ProfileEditor>(
        "/api/upload-profiles/" + u.ownerId,
        {
          method: "PUT",
          body: JSON.stringify({
            ...savedOwner,
            path: value,
            expectedVersion: savedOwner.configVersion,
          }),
        },
      );
      initialized = !!saved.path.ready;
    } else {
      const pipeline = savedOwner as PipelineView;
      const saved = await api<PipelineView>("/api/pipelines/" + u.ownerId, {
        method: "PUT",
        body: JSON.stringify({
          ...pipeline,
          steps: pipeline.steps.map((s) => (s.key === u.key ? value : s)),
          expectedVersion: pipeline.configVersion,
        }),
      });
      initialized = !!saved.steps.find((s) => s.key === u.key)?.ready;
    }
    await Promise.all(
      ["plugin-packages", "plugins", "sources", "profiles", "pipelines"].map(
        (key) => queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
    emit("saved");
    await load();
    if (initialized) notify({ key: "ui.saved" });
    else error.value = t("ui.savedButInitializationFailedEditAndSave");
  } catch (e) {
    error.value = errorText(e);
    if (e instanceof ApiError) {
      fields.value = e.fields;
      if (e.code === "CONFIG_INVALID" || e.fields.length) editing.value = true;
      if (e.code === "CONFLICT")
        error.value += t("ui.yourDraftIsPreservedReloadBeforeSaving");
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Sheet v-model:open="open">
    <SheetContent :busy="busy" class="w-full overflow-y-auto sm:max-w-2xl">
      <SheetTitle
        >{{ t("plugins.upgradeConfigurations") }} · {{ name }}</SheetTitle
      >
      <SheetDescription>{{ t("plugins.upgradeDescription") }}</SheetDescription>
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <p v-if="busy && !draft" class="subtle">{{ t("ui.loading") }}</p>
      <div class="divide-y border-y">
        <div
          v-for="u in outdated"
          :key="u.key"
          class="flex items-center justify-between gap-3 py-3"
        >
          <div>
            <p class="text-sm font-medium">{{ u.name }}</p>
            <p class="subtle">
              {{ t(`plugins.owner.${u.ownerType}`)
              }}<template v-if="u.stage">
                · {{ t(`plugins.stage.${u.stage}`) }} ·
                {{
                  t("plugins.stepNumber", { number: (u.stepIndex ?? 0) + 1 })
                }}</template
              >
              · {{ u.version }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <select
              class="native-select"
              :aria-label="t('plugins.targetVersion') + ' · ' + u.name"
              :value="targets[u.key] ?? versions(u)[0]?.version"
              :disabled="busy"
              @change="
                targets[u.key] = ($event.target as HTMLSelectElement).value
              "
            >
              <option
                v-for="p in versions(u)"
                :key="p.version"
                :value="p.version"
              >
                {{ p.version }}
              </option>
            </select>
            <Button size="sm" :disabled="busy" @click="select(u)">{{
              t("plugins.upgrade")
            }}</Button>
          </div>
        </div>
      </div>
      <p v-if="!busy && !outdated.length" class="subtle">
        {{ t("plugins.upToDate") }}
      </p>
      <Dialog v-model:open="editing">
        <DialogContent :busy="busy" class="max-h-[85vh] overflow-y-auto">
          <DialogTitle>{{ t("plugins.completeUpgrade") }}</DialogTitle>
          <DialogDescription>{{
            t("plugins.completeUpgradeDescription")
          }}</DialogDescription>
          <p v-if="error" role="alert" class="error-box">{{ error }}</p>
          <form
            v-if="selected && draft"
            class="space-y-5 pt-4"
            @submit.prevent="save"
          >
            <h3 class="font-medium">{{ selected.name }}</h3>
            <fieldset :disabled="busy" class="space-y-4">
              <PluginConfigurationEditor
                :key="selected.key"
                v-model="draft"
                :plugins="plugins"
                :kind="
                  selected.ownerType === 'source'
                    ? 'storage'
                    : selected.ownerType === 'profile'
                      ? 'path'
                      : 'processor'
                "
                :stage="selected.stage"
                :label="t('ui.plugin')"
                locked
                upgrade-only
                :errors="fields"
                @ready="ready = $event"
              />
              <div class="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  @click="editing = false"
                  >{{ t("ui.cancel") }}</Button
                >
                <Button
                  type="submit"
                  :loading="busy"
                  :disabled="!draft.upgrade || !ready"
                  >{{ t("plugins.saveUpgrade") }}</Button
                >
              </div>
            </fieldset>
          </form>
        </DialogContent>
      </Dialog>
    </SheetContent>
  </Sheet>
</template>
