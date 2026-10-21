<script setup lang="ts">
import { t, locale } from "@/lib/i18n";
import {
  localizePlugin,
  type LocalizedPlugin,
} from "../../../shared/plugin-localization";
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { comparePluginVersions } from "@/lib/plugin-versions";
import PluginUpgradeSheet from "@/components/PluginUpgradeSheet.vue";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api, errorText, notify, queryClient } from "@/lib/api";
import type { PackageView, PackageInspection } from "../../../shared/config";
const packages = useQuery({
  queryKey: ["plugin-packages"],
  staleTime: 0,
  queryFn: ({ signal }) =>
    api<PackageView[]>("/api/plugin-packages", { signal }),
  select: computed(() => {
    const language = locale.value;
    return (items: PackageView[]) =>
      items.map((item) => localizePlugin(item, language));
  }),
});
type DisplayPackage = LocalizedPlugin<PackageView>;
const packageInput = ref<HTMLInputElement>();
const inspection = ref<PackageInspection | null>(null),
  trusted = ref(false),
  busy = ref(false),
  error = ref(""),
  remove = ref<DisplayPackage | null>(null),
  detailsSelection = ref<DisplayPackage | null>(null);
const details = computed({
  get: () =>
    packages.data.value?.find(
      (p) =>
        p.id === detailsSelection.value?.id &&
        p.version === detailsSelection.value?.version,
    ) ?? null,
  set: (value: DisplayPackage | null) => {
    detailsSelection.value = value;
  },
});
const kinds = computed(() => ({
  path: t("ui.pathStrategy"),
  storage: t("ui.storage"),
  processor: t("ui.processorPlugin"),
}));
const upgradeOpen = ref(false);
const upgradePlugin = ref<DisplayPackage>();
function upgrade(p: DisplayPackage) {
  upgradePlugin.value = p;
  upgradeOpen.value = true;
}
const pluginFamilies = computed(() => {
  const map = new Map<
    string,
    { plugin: DisplayPackage; versions: DisplayPackage[] }
  >();
  for (const p of packages.data.value ?? []) {
    const family = map.get(p.id);
    if (family) family.versions.push(p);
    else map.set(p.id, { plugin: p, versions: [p] });
  }
  return [...map.values()];
});
function hasUpgrades(versions: PackageView[]) {
  return versions.some(
    (p) =>
      p.source === "external" &&
      p.instances.length &&
      versions.some(
        (target) =>
          comparePluginVersions(target.version, p.version) > 0 &&
          target.status === "loaded",
      ),
  );
}
const groups = computed(() =>
  (["storage", "path", "processor"] as const)
    .map((kind) => ({
      kind,
      label: t(`plugins.group.${kind}`),
      items: pluginFamilies.value.filter(({ plugin }) => plugin.kind === kind),
    }))
    .filter((group) => group.items.length),
);
const endpoint = (p: PackageView) =>
  `/api/plugins/${encodeURIComponent(p.id)}/versions/${encodeURIComponent(p.version)}`;
async function refresh() {
  await packages.refetch();
  await queryClient.invalidateQueries({ queryKey: ["plugins"] });
  await queryClient.invalidateQueries({ queryKey: ["instances"] });
}
async function inspect(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = true;
  error.value = "";
  try {
    if (file.size > 20 * 1024 * 1024)
      throw new Error(t("ui.packageExceeds20Mb"));
    const form = new FormData();
    form.set("file", file);
    inspection.value = await api<PackageInspection>("/api/plugins/inspect", {
      method: "POST",
      body: form,
    });
    trusted.value = false;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    input.value = "";
    busy.value = false;
  }
}
async function cancel() {
  const current = inspection.value;
  if (!current) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/plugins/staged/" + current.ticket, { method: "DELETE" });
    inspection.value = null;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function install() {
  if (!inspection.value || !trusted.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api<PackageView>("/api/plugins/install", {
      method: "POST",
      body: JSON.stringify({
        ticket: inspection.value.ticket,
        confirmTrusted: true,
      }),
    });
    inspection.value = null;
    await refresh();
    if (result.status === "failed")
      error.value = t("ui.installedButFailedToLoadRetryOr");
    else notify({ key: "ui.pluginInstalled" });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function reload(p: PackageView) {
  busy.value = true;
  error.value = "";
  try {
    const result = await api<PackageView>(endpoint(p) + "/reload", {
      method: "POST",
    });
    await refresh();
    if (result.error) error.value = t("plugins.loadError");
    else notify({ key: "ui.pluginLoaded" });
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function uninstall() {
  if (!remove.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api(endpoint(remove.value), { method: "DELETE" });
    remove.value = null;
    await refresh();
    notify({ key: "ui.pluginUninstalled" });
  } catch (e) {
    error.value = errorText(e);
    await refresh();
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="page-heading">
          {{ t("ui.plugins") }}
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ t("ui.installPluginsForStoragePathsProcessingAnd") }}
        </p>
      </div>
      <div>
        <Button
          :loading="busy && !inspection && !remove"
          :disabled="busy || !!inspection"
          @click="packageInput?.click()"
        >
          <Plus v-if="!busy" />{{
            busy ? t("ui.processing") : t("ui.uploadPackage")
          }}
        </Button>
        <input
          ref="packageInput"
          :aria-label="t('ui.uploadPackage')"
          type="file"
          accept=".zip,application/zip"
          class="hidden"
          :disabled="busy || !!inspection"
          @change="inspect"
        />
      </div>
    </div>
    <p class="text-sm text-muted-foreground">
      {{ t("ui.zipOnlyUpTo20Mb512") }}
    </p>
    <p
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {{ error }}
    </p>
    <p v-if="packages.isPending.value" class="text-muted-foreground">
      {{ t("ui.loading") }}
    </p>
    <div v-else-if="packages.isError.value" role="alert">
      <p>{{ errorText(packages.error.value) }}</p>
      <Button variant="outline" @click="packages.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <p v-else-if="!packages.data.value?.length" class="text-muted-foreground">
      {{ t("ui.noPluginsInstalled") }}
    </p>
    <div v-else class="space-y-10">
      <section
        v-for="group in groups"
        :key="group.kind"
        :aria-labelledby="'plugins-' + group.kind"
      >
        <h2
          :id="'plugins-' + group.kind"
          class="mb-3 flex items-center gap-3 text-lg font-semibold"
        >
          {{ group.label
          }}<span class="text-sm font-normal text-muted-foreground">{{
            group.items.length
          }}</span>
        </h2>
        <div class="divide-y border-y">
          <article
            v-for="family in group.items"
            :key="family.plugin.id"
            class="space-y-2 py-3"
          >
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0 flex-1 space-y-1">
                <h3 class="font-medium">{{ family.plugin.name }}</h3>
                <p
                  v-if="family.plugin.description"
                  class="text-sm text-muted-foreground"
                >
                  {{ family.plugin.description }}
                </p>
                <div
                  v-if="family.plugin.kind === 'processor'"
                  class="flex flex-wrap gap-2"
                >
                  <span
                    v-for="stage in [
                      ...new Set(
                        family.versions.flatMap((p) => p.supportedStages ?? []),
                      ),
                    ]"
                    :key="stage"
                    class="rounded-md bg-primary/5 px-2 py-1 text-xs text-primary"
                    >{{ t(`plugins.stage.${stage}`) }}</span
                  >
                </div>
              </div>
              <Button
                v-if="hasUpgrades(family.versions)"
                size="sm"
                @click="upgrade(family.plugin)"
                >{{ t("plugins.upgrade") }}</Button
              >
            </div>
            <div
              v-for="p in family.versions"
              :key="p.version"
              class="flex flex-wrap items-center justify-between gap-3"
            >
              <div
                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
              >
                <span class="font-medium text-foreground"
                  >v{{ p.version }}</span
                >
                <span>{{
                  p.source === "builtin"
                    ? t("ui.builtInProtected")
                    : t("ui.external")
                }}</span>
                <span :class="p.status === 'failed' && 'text-destructive'">{{
                  p.status === "loaded" ? t("ui.loaded") : t("ui.loadFailed")
                }}</span>
                <span>{{
                  t("plugins.usageCount", { count: p.instances.length })
                }}</span>
                <span v-if="family.versions.length > 1 && p.canUninstall">{{
                  t("plugins.unusedVersion")
                }}</span>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" @click="details = p">{{
                  t("ui.details")
                }}</Button>
                <Button
                  v-if="p.status === 'failed'"
                  size="sm"
                  variant="outline"
                  :disabled="busy"
                  @click="reload(p)"
                  >{{ t("ui.retryLoading") }}</Button
                >
                <RouterLink
                  v-if="p.status === 'loaded' && p.kind === 'storage'"
                  :to="{
                    path: '/app/config/sources',
                    query: { plugin: p.id + '@' + p.version },
                  }"
                  class="inline-flex items-center px-2 text-sm text-primary"
                  >{{ t("ui.createSource") }}</RouterLink
                >
                <Button
                  v-if="p.source === 'external'"
                  size="sm"
                  variant="outline"
                  :disabled="busy || !p.canUninstall"
                  @click="remove = p"
                  >{{ t("ui.uninstall") }}</Button
                >
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
    <PluginUpgradeSheet
      v-if="upgradePlugin"
      v-model="upgradeOpen"
      :plugin-id="upgradePlugin.id"
      :name="upgradePlugin.name"
      :packages="packages.data.value ?? []"
    />
    <Dialog
      :open="!!inspection"
      @update:open="
        (value) => {
          if (!value && !busy) void cancel();
        }
      "
      ><DialogContent :busy="busy"
        ><DialogTitle>{{ t("ui.installPlugin") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.packageStructureCheckedInstallingWillRunIts")
        }}</DialogDescription>
        <div v-if="inspection" class="space-y-3 text-sm">
          <p>{{ inspection.id }}@{{ inspection.version }}</p>
          <p>
            {{ kinds[inspection.kind] }} ·
            {{
              t("plugins.archiveSize", {
                count: inspection.fileCount,
                size: (inspection.expandedBytes / 1024).toFixed(1),
              })
            }}
          </p>
          <p class="rounded-lg bg-muted p-3">
            {{ t("ui.pluginsCanAccessServerFilesAndThe") }}
          </p>
          <label class="flex gap-2"
            ><input v-model="trusted" type="checkbox" :disabled="busy" />{{
              t("ui.iTrustThisPluginAndAllowIt")
            }}</label
          >
          <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button variant="outline" :disabled="busy" @click="cancel">{{
              t("ui.cancel")
            }}</Button
            ><Button :loading="busy" :disabled="!trusted" @click="install">{{
              busy ? t("ui.installing") : t("ui.install")
            }}</Button>
          </div>
        </div></DialogContent
      ></Dialog
    >
    <Dialog
      :open="!!remove"
      @update:open="
        (value) => {
          if (!value && !busy) remove = null;
        }
      "
      ><DialogContent :busy="busy"
        ><DialogTitle>{{ t("ui.uninstallPlugin") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.removesThisVersionOnlySettingsAndImages")
        }}</DialogDescription>
        <p>{{ remove?.name }} · {{ remove?.version }}</p>
        <p v-if="error" role="alert" class="text-destructive">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="remove = null">{{
            t("ui.cancel")
          }}</Button
          ><Button variant="destructive" :loading="busy" @click="uninstall">{{
            busy ? t("ui.uninstalling") : t("ui.uninstallPlugin2")
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
    <Dialog
      :open="!!details"
      @update:open="
        (value) => {
          if (!value) details = null;
        }
      "
      ><DialogContent
        ><DialogTitle>{{ t("ui.pluginDetails") }}</DialogTitle
        ><DialogDescription>{{ t("ui.statusAndUsage") }}</DialogDescription>
        <div v-if="details" class="space-y-3 text-sm">
          <p>{{ details.name }} · {{ details.id }}@{{ details.version }}</p>
          <p>
            {{
              details.source === "builtin"
                ? t("ui.builtInProtected")
                : t("ui.externalPlugin")
            }}
            ·
            {{
              details.status === "loaded" ? t("ui.loaded") : t("ui.loadFailed")
            }}
          </p>
          <p v-if="details.error" class="text-destructive">
            {{ t("plugins.loadError") }}
          </p>
          <p v-if="!details.instances.length">{{ t("ui.notInUse") }}</p>
          <ul v-else class="space-y-2">
            <li v-for="i in details.instances" :key="i.id">
              <RouterLink
                v-if="details.kind === 'storage'"
                :to="{ path: '/app/config/sources', query: { instance: i.id } }"
                class="text-primary"
                >{{ i.name }}</RouterLink
              >
              <span v-else>{{ i.name }}</span>
            </li>
          </ul>
        </div></DialogContent
      ></Dialog
    >
  </div>
</template>
