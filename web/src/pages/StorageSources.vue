<script setup lang="ts">
import { t, locale, formatNumber } from "@/lib/i18n";
import { localizePlugin } from "../../../shared/plugin-localization";
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import { Plus, RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, ApiError, errorText, notify, queryClient } from "@/lib/api";
import ImportSheet from "@/components/ImportSheet.vue";
import { createPluginDraft } from "@/lib/plugin-draft";
import PluginConfigurationEditor from "@/components/PluginConfigurationEditor.vue";
import type {
  PluginSummary,
  InstanceView,
  PluginConfiguration,
} from "../../../shared/config";
const instances = useQuery({
  queryKey: ["sources"],
  queryFn: ({ signal }) =>
    api<InstanceView[]>("/api/storage-sources", { signal }),
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
const conflict = ref(false),
  open = ref(false),
  busy = ref(false),
  error = ref(""),
  deleting = ref("");
const fieldErrors = ref<Array<{ path: string; message: string }>>([]);
async function refresh() {
  await Promise.all(
    ["sources", "groups", "profiles", "pipelines", "plugins"].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
function capacitySize(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit =
    bytes > 0
      ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
      : 0;
  return `${formatNumber(bytes / 1024 ** unit, { maximumFractionDigits: 1 })} ${units[unit]}`;
}
const rows = computed(() =>
  instances.data.value?.map((item) => {
    const total = item.usedStorageBytes + item.reservedStorageBytes;
    const ratio =
      item.maxStorageBytes == null ? 0 : total / item.maxStorageBytes;
    const usedPercent =
      item.maxStorageBytes == null
        ? 0
        : Math.min(100, (item.usedStorageBytes / item.maxStorageBytes) * 100);
    const percent = Math.min(100, ratio * 100);
    const text =
      item.maxStorageBytes == null
        ? t("storage.usageUnlimited", {
            used: capacitySize(item.usedStorageBytes),
          })
        : t("storage.usageLimited", {
            used: capacitySize(item.usedStorageBytes),
            limit: capacitySize(item.maxStorageBytes),
            percent: formatNumber(Math.floor(ratio * 100)),
          });
    const pendingText =
      item.reservedStorageBytes > 0
        ? t("storage.pending", {
            size: capacitySize(item.reservedStorageBytes),
          })
        : "";
    return {
      ...item,
      usedPercent,
      reservedPercent: Math.max(0, percent - usedPercent),
      percent,
      full: ratio >= 1,
      warning: ratio >= 0.8,
      usageText: text,
      pendingText,
      accessibleUsage: [text, pendingText, ratio >= 1 ? t("storage.full") : ""]
        .filter(Boolean)
        .join(" · "),
    };
  }),
);
const loading = computed(() => instances.isPending.value);
const loadError = computed(() => instances.error.value ?? plugins.error.value);
const route = useRoute();
const instance = ref<InstanceView>(),
  instanceName = ref(""),
  importSource = ref<InstanceView>();
const storage = ref<PluginConfiguration>({
  pluginId: "",
  version: "",
  config: {},
});
const editorReady = ref(false);
const maxStorageGiB = ref<number | string>("");
let openedQuery = "";
watch(
  () => [route.query.plugin, route.query.instance, plugins.data.value],
  async () => {
    if (!plugins.data.value) return;
    const id =
      typeof route.query.instance === "string"
        ? route.query.instance
        : undefined;
    const choice =
      typeof route.query.plugin === "string" ? route.query.plugin : undefined;
    const key = id ?? choice;
    if (!key || openedQuery === key) return;
    openedQuery = key;
    await edit(id);
    if (!id && choice) {
      const plugin = plugins.data.value.find(
        (p) => p.id + "@" + p.version === choice,
      );
      if (plugin) {
        busy.value = true;
        try {
          storage.value = await createPluginDraft(plugin.id, plugin.version);
        } catch (e) {
          error.value = errorText(e);
        } finally {
          busy.value = false;
        }
      }
    }
  },
  { immediate: true },
);
function setInstance(value?: InstanceView) {
  instance.value = value;
  maxStorageGiB.value =
    value?.maxStorageBytes == null ? "" : value.maxStorageBytes / 1024 ** 3;
  instanceName.value = value?.name ?? "";
  storage.value = value
    ? {
        key: value.id,
        pluginId: value.pluginId,
        version: value.version,
        config: value.config,
        secretPresence: value.secretPresence,
        secretEdits: {},
        ready: value.ready,
        error: value.error,
      }
    : { pluginId: "", version: "", config: {} };
}
async function edit(id?: string) {
  conflict.value = false;
  error.value = "";
  fieldErrors.value = [];
  open.value = true;
  busy.value = true;
  try {
    setInstance(
      id ? await api<InstanceView>("/api/storage-sources/" + id) : undefined,
    );
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  error.value = "";
  fieldErrors.value = [];
  busy.value = true;
  try {
    const value = await api<InstanceView>(
      "/api/storage-sources" + (instance.value ? "/" + instance.value.id : ""),
      {
        method: instance.value ? "PUT" : "POST",
        body: JSON.stringify({
          pluginId: storage.value.pluginId,
          version: storage.value.version,
          name: instanceName.value,
          maxStorageBytes:
            maxStorageGiB.value === ""
              ? null
              : Math.round(Number(maxStorageGiB.value) * 1024 ** 3),
          config: storage.value.config,
          secretEdits: storage.value.secretEdits,
          upgrade: storage.value.upgrade,
          expectedVersion: instance.value?.configVersion,
        }),
      },
    );
    setInstance(value);
    if (!value.ready) {
      await refresh();
      error.value = t("ui.savedButInitializationFailedCheckSettingsOr");
      return;
    }
    await refresh();
    open.value = false;
    notify({ key: "ui.saved" });
  } catch (e) {
    error.value = errorText(e);
    if (e instanceof ApiError) {
      fieldErrors.value = e.fields;
      if (e.code === "CONFLICT") {
        conflict.value = true;
        error.value += t("ui.yourDraftIsPreservedReloadBeforeSaving");
      }
    }
  } finally {
    busy.value = false;
  }
}
async function initialize(id: string) {
  busy.value = true;
  error.value = "";
  try {
    const value = await api<InstanceView>(
      "/api/storage-sources/" + id + "/reinitialize",
      { method: "POST" },
    );
    await refresh();
    notify(
      value.ready
        ? { key: "ui.storageSourceReady" }
        : { key: "ui.settingsSavedInitializationFailed" },
    );
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  busy.value = true;
  error.value = "";
  try {
    await api("/api/storage-sources/" + deleting.value, { method: "DELETE" });
    deleting.value = "";
    await refresh();
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
    <div class="mb-7 flex items-start justify-between gap-4">
      <div>
        <h1 class="page-heading">{{ t("ui.storageSources") }}</h1>
        <p class="mt-2 subtle">{{ t("ui.configureStorageConnections") }}</p>
      </div>
      <Button @click="edit()"><Plus />{{ t("ui.create") }}</Button>
    </div>
    <div v-if="loading" class="subtle">{{ t("ui.loading") }}</div>
    <div v-else-if="loadError" class="error-box">
      {{ errorText(loadError)
      }}<Button variant="ghost" @click="refresh">{{ t("ui.retry") }}</Button>
    </div>
    <div v-else-if="!rows?.length" class="py-16 text-center subtle">
      {{ t("configuration.empty") }}
    </div>
    <div v-else class="divide-y border-y">
      <article
        v-for="item in rows"
        :key="item.id"
        class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
      >
        <div class="min-w-0 flex-1">
          <h2 class="break-words font-medium">{{ item.name }}</h2>
          <p class="mt-1 break-words text-sm text-muted-foreground">
            {{
              plugins.data.value?.find(
                (plugin) =>
                  plugin.id === item.pluginId &&
                  plugin.version === item.version,
              )?.name ?? item.pluginId
            }}
            · v{{ item.version }}
            ·
            {{ item.ready ? t("ui.ready") : t("ui.unavailable") }}
            ·
            {{
              t("configuration.references", {
                count: item.references.length,
              })
            }}
          </p>
          <div class="mt-2 max-w-sm space-y-1.5">
            <p
              class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums"
            >
              <span>{{ item.usageText }}</span>
              <span v-if="item.pendingText">· {{ item.pendingText }}</span>
              <span v-if="item.full" class="font-medium text-destructive">{{
                t("storage.full")
              }}</span>
            </p>
            <div
              v-if="item.maxStorageBytes !== null"
              role="progressbar"
              :aria-label="item.name"
              :aria-valuenow="item.percent"
              :aria-valuemin="0"
              :aria-valuemax="100"
              :aria-valuetext="item.accessibleUsage"
              :title="item.accessibleUsage"
              class="flex h-1.5 overflow-hidden rounded-full bg-muted"
              :class="
                item.full
                  ? 'text-destructive'
                  : item.warning
                    ? 'text-amber-500 dark:text-amber-400'
                    : 'text-primary'
              "
            >
              <div
                class="h-full shrink-0 bg-current"
                :style="{ width: item.usedPercent + '%' }"
              />
              <div
                class="h-full shrink-0 bg-current opacity-35"
                :style="{ width: item.reservedPercent + '%' }"
              />
            </div>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2 sm:max-w-72 sm:justify-end">
          <Button
            v-if="item.canImport"
            size="sm"
            variant="outline"
            @click="importSource = item"
            >{{ t("import.title") }}</Button
          >
          <Button
            v-if="!item.ready"
            size="sm"
            variant="outline"
            :disabled="busy"
            @click="initialize(item.id)"
            ><RefreshCw />{{ t("ui.retryInitialization") }}</Button
          ><Button size="sm" variant="outline" @click="edit(item.id)">{{
            t("ui.edit")
          }}</Button
          ><Button
            size="sm"
            variant="ghost"
            @click="
              deleting = item.id;
              error = '';
            "
            >{{ t("ui.delete") }}</Button
          >
        </div>
      </article>
    </div>
    <p v-if="error && !open && !deleting" role="alert" class="error-box mt-4">
      {{ error }}
    </p>
    <ImportSheet
      v-if="importSource"
      :key="importSource.id"
      :source="importSource"
      @close="importSource = undefined"
    />
    <Sheet v-model:open="open"
      ><SheetContent
        :busy="busy"
        class="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl"
        ><div class="shrink-0 px-6 pt-6 pr-12">
          <SheetTitle>{{
            t(`configuration.${instance?.id ? "edit" : "create"}.sources`)
          }}</SheetTitle
          ><SheetDescription>{{
            t("ui.changesApplyToFutureRequests")
          }}</SheetDescription>
        </div>
        <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
          <div class="editor-body">
            <div class="space-y-5">
              <label class="field"
                >{{ t("ui.sourceName")
                }}<Input v-model="instanceName" required maxlength="100"
              /></label>
              <label class="field">
                {{ t("storage.capacity") }}
                <Input
                  v-model="maxStorageGiB"
                  type="number"
                  min="0.000000001"
                  step="any"
                  :placeholder="t('storage.unlimited')"
                />
                <span class="text-xs text-muted-foreground">{{
                  t("storage.capacityHelp")
                }}</span>
              </label>
              <PluginConfigurationEditor
                v-model="storage"
                :plugins="plugins.data.value ?? []"
                kind="storage"
                :label="t('ui.plugin')"
                :locked="!!instance || busy"
                :errors="fieldErrors"
                @ready="editorReady = $event"
              />
              <div
                v-if="
                  instance &&
                  (instance.references.length || instance.replicaCount)
                "
                class="space-y-2 border-t pt-4"
              >
                <p class="text-sm font-medium">{{ t("ui.usedBy") }}</p>
                <p
                  v-if="instance.replicaCount"
                  class="text-sm text-muted-foreground"
                >
                  {{
                    t("configuration.storedReplicas", {
                      count: instance.replicaCount,
                    })
                  }}
                </p>
                <div
                  v-if="instance.references.length"
                  class="max-h-40 space-y-2 overflow-y-auto"
                >
                  <p
                    v-for="reference in instance.references"
                    :key="reference.type + reference.id"
                    class="break-words text-sm text-muted-foreground"
                  >
                    {{ reference.name }}
                  </p>
                </div>
              </div>
            </div>

            <div v-if="error" role="alert" class="error-box">
              {{ error }}
            </div>
          </div>
          <div class="editor-footer">
            <Button
              type="button"
              variant="outline"
              :disabled="busy"
              @click="open = false"
              >{{ t("ui.cancel") }}</Button
            >
            <Button
              type="submit"
              :loading="busy"
              :disabled="busy || !editorReady"
              >{{ busy ? t("ui.saving") : t("ui.save") }}</Button
            ><Button
              v-if="conflict"
              type="button"
              variant="outline"
              :disabled="busy"
              @click="edit(instance?.id)"
              >{{ t("ui.reload") }}</Button
            >
          </div>
        </form>
      </SheetContent></Sheet
    >
    <Dialog
      :open="!!deleting"
      @update:open="
        (value) => {
          if (!value) deleting = '';
        }
      "
      ><DialogContent :busy="busy"
        ><DialogTitle>{{ t("ui.deleteConfiguration") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.existingImagesAreKeptPendingActionsMay")
        }}</DialogDescription>
        <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="deleting = ''">{{
            t("ui.cancel")
          }}</Button
          ><Button variant="destructive" :loading="busy" @click="remove">{{
            busy ? t("ui.deletingNow") : t("ui.confirmDelete")
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </section>
</template>
