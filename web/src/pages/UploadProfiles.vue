<script setup lang="ts">
import { t, locale } from "@/lib/i18n";
import { localizePlugin } from "../../../shared/plugin-localization";
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Plus } from "lucide-vue-next";
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
import {
  api,
  ApiError,
  errorMessage,
  errorText,
  notify,
  queryClient,
} from "@/lib/api";
import PluginConfigurationEditor from "@/components/PluginConfigurationEditor.vue";
import PipelinePicker from "@/components/PipelinePicker.vue";
import type {
  PluginSummary,
  GroupView,
  ProfileEditor as ProfileView,
} from "../../../shared/config";
import type { UploadProfileView } from "../../../shared/api";
const formats = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/avif",
  "image/tiff",
];
const profiles = useQuery({
  queryKey: ["profiles"],
  queryFn: ({ signal }) =>
    api<UploadProfileView[]>("/api/upload-profiles", { signal }),
});
const groups = useQuery({
  queryKey: ["groups"],
  queryFn: ({ signal }) => api<GroupView[]>("/api/storage-groups", { signal }),
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
const rows = computed(() => profiles.data.value);
const loading = computed(() => profiles.isPending.value);
const loadError = computed(
  () => profiles.error.value ?? groups.error.value ?? plugins.error.value,
);
const profile = ref<ProfileView>();
async function edit(id?: string) {
  conflict.value = false;
  error.value = "";
  fieldErrors.value = [];
  open.value = true;
  busy.value = true;
  try {
    profile.value = id
      ? await api<ProfileView>("/api/upload-profiles/" + id)
      : {
          id: "",
          name: "",
          publicPrefix: "/i/",
          path: { pluginId: "", version: "", config: {} },
          storageGroupId: "",
          enabled: true,
          allowGuestUpload: false,
          configVersion: 0,
          maxUploadBytes: 20 * 1024 * 1024,
          allowedMimeTypes: [...formats],
          uploadPipelineId: null,
          postSavePipelineId: null,
        };
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
    if (!profile.value) return;
    const p = profile.value;
    const saved = await api<ProfileView>(
      "/api/upload-profiles" + (p.id ? "/" + p.id : ""),
      {
        method: p.id ? "PUT" : "POST",
        body: JSON.stringify({ ...p, expectedVersion: p.configVersion }),
      },
    );
    profile.value = saved;
    if ([saved.path].some((s) => !s.ready)) {
      await refresh();
      error.value = t("ui.savedButSomePluginsFailedToInitialize");
      return;
    }
    await refresh();
    open.value = false;
    notify(t("ui.saved"));
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
async function remove() {
  busy.value = true;
  error.value = "";
  try {
    await api("/api/upload-profiles/" + deleting.value, { method: "DELETE" });
    deleting.value = "";
    await refresh();
    notify(t("ui.deleted"));
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
        <h1 class="page-heading">{{ t("ui.uploadProfiles") }}</h1>
        <p class="mt-2 subtle">
          {{ t("ui.setPathsStorageProcessingAndActions") }}
        </p>
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
            {{ item.publicPrefix }} ·
            {{ item.available ? t("ui.ready") : errorMessage(item.reasonCode) }}
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2 sm:max-w-72 sm:justify-end">
          <Button size="sm" variant="outline" @click="edit(item.id)">{{
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

    <Sheet v-model:open="open"
      ><SheetContent
        :busy="busy"
        class="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl"
        ><div class="shrink-0 px-6 pt-6 pr-12">
          <SheetTitle>{{
            t(`configuration.${profile?.id ? "edit" : "create"}.profiles`)
          }}</SheetTitle
          ><SheetDescription>{{
            t("ui.changesApplyToFutureRequests")
          }}</SheetDescription>
        </div>
        <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
          <div class="editor-body">
            <template v-if="profile"
              ><label class="field"
                >{{ t("ui.profileName")
                }}<Input
                  v-model="profile.name"
                  required
                  maxlength="100" /></label
              ><label class="field"
                >{{ t("ui.publicPrefix")
                }}<Input v-model="profile.publicPrefix" required
              /></label>
              <div class="space-y-3">
                <h3 class="text-sm font-medium">{{ t("ui.pathStrategy") }}</h3>
                <PluginConfigurationEditor
                  :errors="fieldErrors"
                  v-model="profile.path"
                  :plugins="plugins.data.value ?? []"
                  kind="path"
                  :label="t('ui.pathPlugin')"
                />
              </div>
              <label class="field"
                >{{ t("ui.storageGroup")
                }}<select
                  :aria-label="t('ui.storageGroup')"
                  v-model="profile.storageGroupId"
                  class="native-select"
                  required
                >
                  <option value="" disabled>
                    {{ t("ui.selectAStorageGroup") }}
                  </option>
                  <option
                    v-for="g in groups.data.value"
                    :key="g.id"
                    :value="g.id"
                  >
                    {{ g.name }}
                  </option>
                </select></label
              ><label class="field"
                >{{ t("ui.uploadLimitBytes")
                }}<Input
                  v-model="profile.maxUploadBytes"
                  type="number"
                  min="1"
                  required
              /></label>
              <fieldset class="space-y-2">
                <legend class="mb-2 text-sm">
                  {{ t("ui.allowedFormats") }}
                </legend>
                <label
                  v-for="mime in formats"
                  :key="mime"
                  class="mr-4 inline-flex gap-2 text-sm"
                  ><input
                    v-model="profile.allowedMimeTypes"
                    type="checkbox"
                    :value="mime"
                  />{{ mime.replace("image/", "") }}</label
                >
              </fieldset>
              <label class="flex items-center gap-2 text-sm"
                ><input v-model="profile.allowGuestUpload" type="checkbox" />{{
                  t("users.allowGuestUpload")
                }}</label
              >
              <label class="flex gap-2 text-sm"
                ><input v-model="profile.enabled" type="checkbox" />{{
                  t("ui.enableProfile")
                }}</label
              >
              <PipelinePicker
                v-model="profile.uploadPipelineId"
                kind="upload"
              />
              <PipelinePicker
                v-model="profile.postSavePipelineId"
                kind="post_save"
              />
            </template>
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
            <Button type="submit" :loading="busy" :disabled="busy">{{
              busy ? t("ui.saving") : t("ui.save")
            }}</Button
            ><Button
              v-if="conflict"
              type="button"
              variant="outline"
              :disabled="busy"
              @click="edit(profile?.id)"
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
