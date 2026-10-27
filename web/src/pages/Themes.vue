<script setup lang="ts">
import { ref, shallowRef, onMounted, computed } from "vue";
import type { Config, InstalledTheme, Manifest } from "@picloom/theme-sdk";
import { api, ApiError, errorText, notify } from "../lib/api";
import PackageUploadStatus from "../components/PackageUploadStatus.vue";
import { usePackageUpload } from "../lib/package-upload";
import { t, locale } from "../lib/i18n";
import { Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import ActionMenu from "@/components/ActionMenu.vue";
import ActionMenuItem from "@/components/ActionMenuItem.vue";
import { messageText } from "../../../shared/package-localization";
function themeName(manifest: Manifest) {
  return messageText(manifest, locale.value, manifest.nameKey);
}
import { languages } from "../../../shared/locales";
import ThemeField from "../components/ThemeField.vue";
const packageInput = ref<HTMLInputElement>();
const themes = shallowRef<InstalledTheme[]>([]),
  selected = shallowRef<InstalledTheme | null>(null),
  config = shallowRef<Config>({});
const inspected = shallowRef<{ ticket: string; manifest: Manifest } | null>(
    null,
  ),
  confirmed = ref(false),
  busy = ref(false),
  error = ref("");
const editSession = ref(0);
const { state: packageUpload, upload } = usePackageUpload();
const defaultLocale = ref("");
const languageRevision = ref(0);
const editLanguages = computed(() =>
  languages.filter((lang) =>
    selected.value?.manifest.supportedLocales.includes(lang.tag),
  ),
);
const defaultLanguages = computed(() =>
  editLanguages.value.filter((lang) =>
    selected.value?.enabledLocales?.includes(lang.tag),
  ),
);
const validDefault = computed(() =>
  defaultLanguages.value.some((lang) => lang.tag === defaultLocale.value),
);

async function load() {
  themes.value = await api<InstalledTheme[]>("/api/themes");
}
async function run(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value =
      errorText(e) +
      (e instanceof ApiError && e.fields.length
        ? " · " + e.fields.map((field) => field.path).join(", ")
        : "");
  } finally {
    busy.value = false;
  }
}
function edit(theme: InstalledTheme) {
  editSession.value++;
  selected.value = theme;
  config.value = structuredClone(theme.config);
  defaultLocale.value = theme.manifest.supportedLocales.includes(
    theme.siteDefaultLocale ?? "",
  )
    ? theme.siteDefaultLocale!
    : "";
  languageRevision.value = theme.languageRevision ?? 0;
}
const path = () =>
  `/api/themes/${selected.value!.manifest.id}/${selected.value!.manifest.version}`;
async function inspect(file?: File) {
  if (!file || busy.value) return;
  inspected.value = null;
  confirmed.value = false;
  await run(async () => {
    inspected.value = await upload("/api/themes/inspect", file, file);
  });
}
async function save() {
  await api(path() + "/config", {
    method: "PUT",
    body: JSON.stringify({
      config: config.value,
      language: {
        defaultLocale: defaultLocale.value,
        languageRevision: languageRevision.value,
      },
    }),
  });
  await load();
  notify({ key: "themes.saved" });
}
function preview(page: string) {
  const m = selected.value!.manifest;
  window.open(
    `${page === "home" ? "/" : "/login"}?previewId=${encodeURIComponent(m.id)}&previewVersion=${encodeURIComponent(m.version)}`,
    "_blank",
    "noopener,noreferrer",
  );
}
onMounted(() => run(load));
</script>
<template>
  <div>
    <header class="page-header">
      <div class="min-w-0">
        <h1 class="page-heading">{{ t("themes.title") }}</h1>
        <p class="mt-2 subtle">{{ t("themes.trust") }}</p>
      </div>
      <Button class="shrink-0" :disabled="busy" @click="packageInput?.click()">
        <Plus />{{ t("themes.uploadPackage") }}
      </Button>
      <input
        ref="packageInput"
        type="file"
        accept=".zip"
        class="hidden"
        :aria-label="t('themes.upload')"
        :disabled="busy"
        @change="
          inspect(($event.target as HTMLInputElement).files?.[0]);
          ($event.target as HTMLInputElement).value = '';
        "
      />
    </header>
    <div class="space-y-6">
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <div class="flex flex-wrap items-center gap-3">
        <span class="subtle">{{ t("themes.packageHint") }}</span>
        <Button
          variant="outline"
          :disabled="busy"
          @click="
            run(async () => {
              await api('/api/theme', {
                method: 'PUT',
                body: JSON.stringify({ id: null }),
              });
              await load();
            })
          "
        >
          {{ t("themes.restore") }}
        </Button>
        <span v-if="!themes.some((v) => v.active)" class="subtle">{{
          t("themes.defaultActive")
        }}</span>
      </div>
      <PackageUploadStatus v-if="packageUpload" :state="packageUpload" />
      <div v-if="inspected" class="panel space-y-4 p-4">
        <p>
          {{ themeName(inspected.manifest) }} · {{ inspected.manifest.version }}
          <span v-if="inspected.manifest.author">
            · {{ inspected.manifest.author }}</span
          >
        </p>
        <label class="flex items-center gap-2 text-sm"
          ><input type="checkbox" v-model="confirmed" />{{
            t("themes.confirmTrust")
          }}</label
        ><Button
          :disabled="busy || !confirmed"
          @click="
            run(async () => {
              await api('/api/themes/install', {
                method: 'POST',
                body: JSON.stringify({ ticket: inspected!.ticket, confirmed }),
              });
              inspected = null;
              await load();
            })
          "
        >
          {{ t("themes.install") }}
        </Button>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <div
          v-for="theme in themes"
          :key="theme.manifest.id + theme.manifest.version"
          class="panel space-y-3 p-4"
        >
          <img
            v-if="theme.manifest.preview"
            :src="theme.baseUrl + theme.manifest.preview"
            alt=""
            class="h-36 w-full rounded object-cover"
          />
          <h2 class="font-medium">
            {{ themeName(theme.manifest) }} · {{ theme.manifest.version }}
            <span
              v-if="theme.active"
              class="text-xs font-normal text-muted-foreground"
              >{{ t("themes.active") }}</span
            >
          </h2>
          <p class="subtle">
            {{ theme.manifest.id }}
            <span v-if="theme.manifest.author">
              · {{ theme.manifest.author }}</span
            >
          </p>
          <p v-if="!theme.compatible" class="error-box">
            {{ t("themes.incompatible") }}
          </p>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              :disabled="busy || !theme.compatible"
              @click="edit(theme)"
            >
              {{ t("themes.configure") }}
            </Button>
            <ActionMenu
              :label="
                t('ui.moreActions', {
                  name:
                    themeName(theme.manifest) + ' · v' + theme.manifest.version,
                })
              "
            >
              <ActionMenuItem
                destructive
                :disabled="busy || theme.active"
                :description="theme.active ? t('themes.active') : undefined"
                @select="
                  run(async () => {
                    await api(
                      `/api/themes/${theme.manifest.id}/${theme.manifest.version}`,
                      { method: 'DELETE' },
                    );
                    if (
                      selected?.manifest.id === theme.manifest.id &&
                      selected?.manifest.version === theme.manifest.version
                    )
                      selected = null;
                    await load();
                  })
                "
              >
                {{ t("themes.uninstall") }}
              </ActionMenuItem>
            </ActionMenu>
          </div>
        </div>
      </div>
      <fieldset
        v-if="selected"
        :disabled="busy"
        class="panel max-w-2xl space-y-5 p-6"
      >
        <div class="space-y-2">
          <h2 class="section-heading">
            {{ themeName(selected.manifest) }} · {{ selected.manifest.version }}
          </h2>
          <p class="subtle">{{ t("themes.draftHelp") }}</p>
        </div>
        <section class="space-y-2">
          <label class="field"
            >{{ t("settings.defaultLocale") }}
            <select v-model="defaultLocale" class="native-select">
              <option value="" disabled>
                {{ t("themes.chooseLanguage") }}
              </option>
              <option
                v-for="lang in defaultLanguages"
                :key="lang.tag"
                :value="lang.tag"
              >
                {{ lang.name }}
              </option>
            </select>
          </label>
          <p class="subtle">{{ t("themes.siteLanguageHelp") }}</p>
          <p v-if="!defaultLanguages.length" role="alert">
            {{ t("themes.enableLanguage") }}
          </p>
          <p
            v-if="
              selected.draftLanguage &&
              selected.draftLanguage.defaultLocale !==
                selected.siteDefaultLocale
            "
            class="subtle"
          >
            {{ t("themes.draftLanguageDifference") }}:
            {{ selected.draftLanguage.defaultLocale }}
          </p>
        </section>
        <section v-if="selected.manifest.configSchema" class="space-y-4">
          <ThemeField
            :key="editSession"
            :field="selected.manifest.configSchema"
            :localization="selected.manifest"
            :value="config"
            :editing-locale="
              defaultLocale || selected.manifest.supportedLocales[0]!
            "
            :enabled-locales="selected.enabledLocales"
            @change="config = $event as Config"
          />
        </section>
        <p v-if="!selected.manifest.configSchema" class="subtle">
          {{ t("themes.noConfig") }}
        </p>
        <div class="form-actions">
          <Button
            variant="outline"
            :disabled="busy || !validDefault"
            @click="run(save)"
          >
            {{ t("themes.saveDraft") }}</Button
          ><Button variant="outline" :disabled="busy" @click="preview('home')">
            {{ t("themes.previewHome") }}</Button
          ><Button variant="outline" :disabled="busy" @click="preview('login')">
            {{ t("themes.previewLogin") }}</Button
          ><Button
            :disabled="busy || !validDefault"
            @click="
              run(async () => {
                await save();
                await api('/api/theme', {
                  method: 'PUT',
                  body: JSON.stringify({
                    id: selected!.manifest.id,
                    version: selected!.manifest.version,
                    defaultLocale,
                    languageRevision,
                  }),
                });
                await load();
                edit(
                  themes.find(
                    (v) =>
                      v.manifest.id === selected!.manifest.id &&
                      v.manifest.version === selected!.manifest.version,
                  )!,
                );
                notify({ key: 'themes.applied' });
              })
            "
          >
            {{ t("themes.apply") }}
          </Button>
        </div>
      </fieldset>
    </div>
  </div>
</template>
