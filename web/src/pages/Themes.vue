<script setup lang="ts">
import { ref, shallowRef, onMounted, computed } from "vue";
import type { Config, InstalledTheme, Manifest } from "../../../theme-sdk";
import { api, ApiError, errorText, notify, queryClient } from "../lib/api";
import { t, locale } from "../lib/i18n";
import { messageText } from "../../../shared/package-localization";
function themeName(manifest: Manifest) {
  return messageText(manifest, locale.value, manifest.nameKey);
}
import { languages } from "../../../shared/locales";
import ThemeField from "../components/ThemeField.vue";
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
  if (!file) return;
  inspected.value = null;
  confirmed.value = false;
  await run(async () => {
    inspected.value = await api("/api/themes/inspect", {
      method: "POST",
      body: file,
    });
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
  <div class="space-y-6">
    <h1 class="text-2xl font-semibold">{{ t("themes.title") }}</h1>
    <p class="subtle">{{ t("themes.trust") }}</p>
    <p v-if="error" role="alert" class="error-box">{{ error }}</p>
    <div class="panel flex flex-wrap items-center gap-4 p-4">
      <label class="field"
        >{{ t("themes.upload")
        }}<input
          type="file"
          accept=".zip"
          :disabled="busy"
          @change="
            inspect(($event.target as HTMLInputElement).files?.[0]);
            ($event.target as HTMLInputElement).value = '';
          "
      /></label>
      <button
        class="native-select"
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
      </button>
      <span v-if="!themes.some((v) => v.active)" class="subtle">{{
        t("themes.defaultActive")
      }}</span>
    </div>
    <div v-if="inspected" class="panel space-y-4 p-4">
      <p>
        {{ themeName(inspected.manifest) }} · {{ inspected.manifest.version }}
      </p>
      <label class="flex gap-2"
        ><input type="checkbox" v-model="confirmed" />{{
          t("themes.confirmTrust")
        }}</label
      ><button
        class="native-select"
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
      </button>
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
        <h2 class="font-semibold">
          {{ themeName(theme.manifest) }} · {{ theme.manifest.version }}
          <span v-if="theme.active">✓ {{ t("themes.active") }}</span>
        </h2>
        <p class="subtle">{{ theme.manifest.id }}</p>
        <p v-if="!theme.compatible" class="error-box">
          {{ t("themes.incompatible") }}
        </p>
        <button
          class="native-select"
          :disabled="busy || !theme.compatible"
          @click="edit(theme)"
        >
          {{ t("themes.configure") }}
        </button>
        <button
          class="ml-3 text-destructive"
          :disabled="busy || theme.active"
          @click="
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
        </button>
      </div>
    </div>
    <fieldset v-if="selected" :disabled="busy" class="panel space-y-5 p-5">
      <h2 class="text-xl font-semibold">
        {{ themeName(selected.manifest) }} · {{ selected.manifest.version }}
      </h2>
      <p class="subtle">{{ t("themes.draftHelp") }}</p>
      <section class="space-y-3">
        <label class="field"
          >{{ t("settings.defaultLocale") }}
          <select v-model="defaultLocale" class="native-select">
            <option value="" disabled>{{ t("themes.chooseLanguage") }}</option>
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
            selected.draftLanguage.defaultLocale !== selected.siteDefaultLocale
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
      <div class="flex flex-wrap gap-4">
        <button
          class="native-select"
          :disabled="busy || !validDefault"
          @click="run(save)"
        >
          {{ t("themes.saveDraft") }}</button
        ><button :disabled="busy" @click="preview('home')">
          {{ t("themes.previewHome") }}</button
        ><button :disabled="busy" @click="preview('login')">
          {{ t("themes.previewLogin") }}</button
        ><button
          class="rounded-lg bg-primary px-4 py-2 text-primary-foreground"
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
        </button>
      </div>
    </fieldset>
  </div>
</template>
