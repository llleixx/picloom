<script setup lang="ts">
import { ref, watch, computed, useId } from "vue";
import { useQuery } from "@tanstack/vue-query";
import type { DeliverySettings } from "../../../shared/api";
import { api, ApiError, errorText, notify, queryClient } from "@/lib/api";
import { t, type MessageKey } from "@/lib/i18n";
import {
  runtimeDefaults,
  runtimeMaximums,
  type RuntimeSettings,
} from "../../../shared/runtime-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  languages,
  defaultLocalization,
  type Locale,
} from "../../../shared/locales";
import TranslationDialog from "@/components/TranslationDialog.vue";
type ContentField = "name" | "description";
const contentId = useId();
const query = useQuery({
  queryKey: ["delivery-settings"],
  queryFn: () => api<DeliverySettings>("/api/settings"),
  refetchOnWindowFocus: false,
});
const draft = ref<DeliverySettings>({
  ...runtimeDefaults,
  guestMaxUploadBytes: null,
  guestDailyUploadLimit: null,
  ...defaultLocalization(),
  siteLogoUrl: "",
  siteFaviconUrl: "",
  imageOrigin: null,
  cacheBytes: 1024 ** 3,
  cacheTtlMs: 86400000,
  publicOrigin: "",
  trustedProxies: [],
  imageCacheMaxAge: 300,
  hotlinkEnabled: false,
  hotlinkAllowedHosts: [],
  hotlinkAllowEmpty: true,
});
const editingLanguageName = computed(
  () =>
    languages.find((language) => language.tag === draft.value.defaultLocale)!
      .name,
);
const editingContent = computed(
  () => draft.value.content[draft.value.defaultLocale] ?? {},
);
function updateContent(field: ContentField, value: string | number) {
  const content = (draft.value.content[draft.value.defaultLocale] ??= {});
  content[field] = String(value);
}
const translationOpen = ref(false);
const translationField = ref<ContentField>("name");
const translations = ref<Record<string, string>>({});
const translationTitle = computed(() =>
  t(
    translationField.value === "name"
      ? "settings.siteName"
      : "settings.siteDescription",
  ),
);
function editTranslations(field: ContentField) {
  translationField.value = field;
  translations.value = Object.fromEntries(
    languages.map((language) => [
      language.tag,
      draft.value.content[language.tag]?.[field] ?? "",
    ]),
  );
  translationOpen.value = true;
}
function confirmTranslations() {
  for (const language of languages) {
    const content = (draft.value.content[language.tag] ??= {});
    content[translationField.value] = translations.value[language.tag] ?? "";
  }
  translationOpen.value = false;
}
function enableLanguage(language: Locale, enabled: boolean) {
  if (enabled) draft.value.enabledLocales.push(language);
  else
    draft.value.enabledLocales = draft.value.enabledLocales.filter(
      (value) => value !== language,
    );
}
type LimitField = {
  key: keyof RuntimeSettings;
  label: MessageKey;
  unit: number;
  advanced?: boolean;
};
const limitGroups: Array<{
  id: string;
  title: MessageKey;
  hint: MessageKey;
  fields: LimitField[];
}> = [
  {
    id: "upload",
    title: "settings.upload",
    hint: "settings.uploadHint",
    fields: [
      { key: "maxUploadBytes", label: "settings.maxUpload", unit: 1048576 },
      {
        key: "chunkThresholdBytes",
        label: "settings.chunkThreshold",
        unit: 1048576,
      },
      { key: "chunkPartBytes", label: "settings.chunkSize", unit: 1048576 },
      {
        key: "uploadConcurrency",
        label: "settings.uploadConcurrency",
        unit: 1,
      },
      { key: "partConcurrency", label: "settings.partConcurrency", unit: 1 },
      {
        key: "uploadSessionLimit",
        label: "settings.uploadSessions",
        unit: 1,
        advanced: true,
      },
      {
        key: "uploadSessionTtlMs",
        label: "settings.uploadLifetime",
        unit: 3600000,
        advanced: true,
      },
    ],
  },
  {
    id: "processing",
    title: "settings.processing",
    hint: "settings.processingHint",
    fields: [
      { key: "maxDimension", label: "settings.maxDimension", unit: 1 },
      { key: "maxPixels", label: "settings.maxPixels", unit: 1000000 },
      {
        key: "processingConcurrency",
        label: "settings.processingConcurrency",
        unit: 1,
        advanced: true,
      },
      {
        key: "processingQueue",
        label: "settings.processingQueue",
        unit: 1,
        advanced: true,
      },
      {
        key: "writeConcurrency",
        label: "settings.writeConcurrency",
        unit: 1,
        advanced: true,
      },
      {
        key: "postSaveConcurrency",
        label: "settings.postSaveConcurrency",
        unit: 1,
        advanced: true,
      },
      {
        key: "deleteConcurrency",
        label: "settings.deleteConcurrency",
        unit: 1,
        advanced: true,
      },
      {
        key: "retryLimit",
        label: "settings.retryLimit",
        unit: 1,
        advanced: true,
      },
    ],
  },
];
const expanded = ref<Record<string, boolean>>({});
const loaded = ref(false);
const siteLink = ref("");
const domains = ref("");
const proxies = ref("");
const busy = ref(false),
  error = ref("");
const fields = ref<Record<string, string>>({});
watch(
  query.data,
  (value) => {
    if (value && !loaded.value) {
      loaded.value = true;
      // Query results are readonly; the editor owns its nested arrays and content.
      draft.value = JSON.parse(JSON.stringify(value));
      domains.value = value.hotlinkAllowedHosts.join("\n");
      proxies.value = value.trustedProxies.join("\n");
    }
  },
  { immediate: true },
);
async function save() {
  if (!draft.value || busy.value) return;
  busy.value = true;
  error.value = "";
  fields.value = {};
  try {
    const value = await api<DeliverySettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...draft.value,
        imageOrigin: draft.value.imageOrigin?.trim() || null,
        trustedProxies: proxies.value
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
        hotlinkAllowedHosts: domains.value
          .split(/\r?\n/)
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    });
    draft.value = JSON.parse(JSON.stringify(value));
    siteLink.value =
      value.publicOrigin && value.publicOrigin !== window.location.origin
        ? value.publicOrigin + "/app/settings"
        : "";
    domains.value = value.hotlinkAllowedHosts.join("\n");
    proxies.value = value.trustedProxies.join("\n");
    queryClient.setQueryData(["delivery-settings"], value);
    await Promise.all(
      ["files", "profiles", "client-settings"].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
    notify({ key: "settings.saved" });
  } catch (e) {
    error.value = errorText(e);
    if (e instanceof ApiError)
      fields.value = Object.fromEntries(
        e.fields.map((f) => [f.path, f.message]),
      );
    for (const group of limitGroups)
      if (group.fields.some((f) => f.advanced && fields.value["/" + f.key]))
        expanded.value[group.id] = true;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="max-w-2xl">
    <h1 class="page-heading">{{ t("settings.title") }}</h1>
    <p v-if="query.isPending.value" class="subtle mt-6">
      {{ t("ui.loading") }}
    </p>
    <div v-else-if="query.isError.value && !loaded" class="mt-6 space-y-3">
      <p role="alert" class="error-box">{{ errorText(query.error.value) }}</p>
      <Button variant="outline" @click="query.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <TranslationDialog
      v-model:open="translationOpen"
      :title="translationTitle"
      :help="t('settings.translationHelp')"
      @confirm="confirmTranslations"
    >
      <div v-for="language in languages" :key="language.tag" class="space-y-2">
        <label class="field">
          <span
            >{{ language.name
            }}<span
              v-if="!draft.enabledLocales.includes(language.tag)"
              class="font-normal text-muted-foreground"
            >
              · {{ t("ui.languageDisabled") }}</span
            ></span
          >
          <Input
            v-model="translations[language.tag]"
            :maxlength="translationField === 'name' ? 100 : 300"
            :aria-invalid="
              !!fields[`/content/${language.tag}/${translationField}`]
            "
          />
        </label>
        <p
          v-if="fields[`/content/${language.tag}/${translationField}`]"
          class="text-sm text-destructive"
        >
          {{ fields[`/content/${language.tag}/${translationField}`] }}
        </p>
      </div>
    </TranslationDialog>
    <form v-if="loaded" class="mt-7" @submit.prevent="save">
      <fieldset :disabled="busy" class="space-y-7">
        <section class="border-t pt-6 space-y-4">
          <h2 class="font-medium">{{ t("settings.website") }}</h2>
          <div class="space-y-3">
            <p class="text-sm font-medium">
              {{ t("settings.enabledLocales") }}
            </p>
            <label
              v-for="language in languages"
              :key="language.tag"
              class="mr-4 inline-flex items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                :checked="draft.enabledLocales.includes(language.tag)"
                :disabled="language.tag === draft.defaultLocale"
                @change="
                  enableLanguage(
                    language.tag,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
              {{ language.name }}
            </label>
            <p
              v-if="fields['/enabledLocales']"
              class="text-sm text-destructive"
            >
              {{ fields["/enabledLocales"] }}
            </p>
            <label class="field"
              >{{ t("settings.defaultLocale") }}
              <select
                v-model="draft.defaultLocale"
                class="native-select"
                :aria-label="t('settings.defaultLocale')"
              >
                <option
                  v-for="language in languages.filter((item) =>
                    draft.enabledLocales.includes(item.tag),
                  )"
                  :key="language.tag"
                  :value="language.tag"
                >
                  {{ language.name }}
                </option>
              </select>
            </label>
            <p v-if="fields['/defaultLocale']" class="text-sm text-destructive">
              {{ fields["/defaultLocale"] }}
            </p>
            <p class="subtle">{{ t("settings.languageHint") }}</p>
          </div>
          <div class="space-y-4 pt-3 pb-2">
            <h3 class="text-sm font-medium">{{ t("settings.siteContent") }}</h3>
            <div
              v-for="field in ['name', 'description'] as const"
              :key="field"
              class="space-y-2"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <label
                  :for="contentId + '-' + field"
                  class="relative pr-3 text-sm font-medium"
                >
                  {{
                    t(
                      field === "name"
                        ? "settings.siteName"
                        : "settings.siteDescription",
                    )
                  }}
                  <span class="font-normal text-muted-foreground">
                    · {{ editingLanguageName }}</span
                  >
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  :aria-label="
                    t('ui.editTranslations') +
                    ' · ' +
                    t(
                      field === 'name'
                        ? 'settings.siteName'
                        : 'settings.siteDescription',
                    )
                  "
                  @click="editTranslations(field)"
                  >{{ t("ui.editTranslations") }}</Button
                >
              </div>
              <Input
                :id="contentId + '-' + field"
                :aria-label="
                  t(
                    field === 'name'
                      ? 'settings.siteName'
                      : 'settings.siteDescription',
                  ) +
                  ' · ' +
                  editingLanguageName
                "
                :model-value="editingContent[field] ?? ''"
                @update:model-value="updateContent(field, $event)"
                :maxlength="field === 'name' ? 100 : 300"
                :aria-invalid="
                  !!fields[`/content/${draft.defaultLocale}/${field}`]
                "
              />
              <p
                v-if="fields[`/content/${draft.defaultLocale}/${field}`]"
                class="text-sm text-destructive"
              >
                {{ fields[`/content/${draft.defaultLocale}/${field}`] }}
              </p>
            </div>
            <p v-if="fields['/content']" class="text-sm text-destructive">
              {{ fields["/content"] }}
            </p>
          </div>
          <hr class="border-border" />
          <div
            v-for="field in ['siteLogoUrl', 'siteFaviconUrl'] as const"
            :key="field"
          >
            <label class="field"
              >{{ t(("settings." + field) as MessageKey) }}
              <Input
                v-model="draft[field]"
                type="text"
                inputmode="url"
                :maxlength="2048"
                :aria-invalid="!!fields['/' + field]"
              />
            </label>
            <p class="subtle mt-1">
              {{
                t(
                  field === "siteLogoUrl"
                    ? "settings.siteLogoHint"
                    : "settings.siteFaviconHint",
                )
              }}
            </p>
            <p v-if="fields['/' + field]" class="mt-1 text-sm text-destructive">
              {{ fields["/" + field] }}
            </p>
          </div>
          <label class="field"
            >{{ t("settings.siteOrigin") }}
            <Input
              v-model="draft.publicOrigin"
              type="url"
              placeholder="https://img.example.com"
              :aria-invalid="!!fields['/publicOrigin']"
              aria-describedby="site-hint site-error"
            />
          </label>
          <p
            v-if="fields['/publicOrigin']"
            id="site-error"
            class="text-sm text-destructive"
          >
            {{ fields["/publicOrigin"] }}
          </p>
          <p id="site-hint" class="subtle">{{ t("settings.siteHint") }}</p>
          <label class="field"
            >{{ t("settings.trustedProxies") }}
            <textarea
              v-model="proxies"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              rows="3"
              :aria-invalid="!!fields['/trustedProxies']"
              aria-describedby="proxies-hint proxies-error"
            />
          </label>
          <p
            v-if="fields['/trustedProxies']"
            id="proxies-error"
            class="text-sm text-destructive"
          >
            {{ fields["/trustedProxies"] }}
          </p>
          <p id="proxies-hint" class="subtle">
            {{ t("settings.trustedProxiesHint") }}
          </p>
        </section>
        <section
          v-for="group in limitGroups"
          :key="group.id"
          class="border-t pt-6 space-y-4"
        >
          <h2 class="font-medium">{{ t(group.title) }}</h2>
          <p class="subtle">{{ t(group.hint) }}</p>
          <template v-for="advanced in [false, true]" :key="String(advanced)">
            <Button
              v-if="advanced"
              type="button"
              variant="ghost"
              size="sm"
              :aria-expanded="!!expanded[group.id]"
              :aria-controls="group.id + '-advanced'"
              @click="expanded[group.id] = !expanded[group.id]"
            >
              {{
                t(
                  expanded[group.id]
                    ? "settings.hideAdvanced"
                    : "settings.showAdvanced",
                )
              }}
            </Button>
            <div
              v-show="!advanced || expanded[group.id]"
              :id="advanced ? group.id + '-advanced' : undefined"
              class="grid gap-4 sm:grid-cols-2"
            >
              <div
                v-for="field in group.fields.filter(
                  (f) => !!f.advanced === advanced,
                )"
                :key="field.key"
              >
                <label class="field"
                  >{{ t(field.label) }}
                  <Input
                    :model-value="draft[field.key] / field.unit"
                    @update:model-value="
                      draft[field.key] = Math.round(Number($event) * field.unit)
                    "
                    type="number"
                    :min="field.unit === 1 ? 1 : 0.001"
                    :step="field.unit === 1 ? 1 : 'any'"
                    :max="
                      runtimeMaximums[field.key]
                        ? runtimeMaximums[field.key]! / field.unit
                        : undefined
                    "
                    required
                    :aria-invalid="!!fields['/' + field.key]"
                    :aria-describedby="field.key + '-error'"
                  />
                </label>
                <p
                  v-if="fields['/' + field.key]"
                  :id="field.key + '-error'"
                  class="mt-1 text-sm text-destructive"
                >
                  {{ fields["/" + field.key] }}
                </p>
              </div>
            </div>
          </template>
        </section>
        <section class="border-t pt-6 space-y-4">
          <h2 class="font-medium">{{ t("limits.guest") }}</h2>
          <p class="subtle">{{ t("limits.guestHint") }}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="field"
              >{{ t("limits.maxSize")
              }}<Input
                type="number"
                min="0.001"
                step="any"
                :placeholder="t('limits.unlimited')"
                :model-value="
                  draft.guestMaxUploadBytes === null
                    ? ''
                    : draft.guestMaxUploadBytes / 1048576
                "
                @update:model-value="
                  draft.guestMaxUploadBytes =
                    $event === '' ? null : Math.round(Number($event) * 1048576)
                "
            /></label>
            <label class="field"
              >{{ t("limits.daily")
              }}<Input
                type="number"
                min="0"
                step="1"
                :placeholder="t('limits.unlimited')"
                :model-value="draft.guestDailyUploadLimit ?? ''"
                @update:model-value="
                  draft.guestDailyUploadLimit =
                    $event === '' ? null : Number($event)
                "
            /></label>
          </div>
          <p
            v-if="
              fields['/guestMaxUploadBytes'] || fields['/guestDailyUploadLimit']
            "
            class="text-destructive"
          >
            {{
              fields["/guestMaxUploadBytes"] || fields["/guestDailyUploadLimit"]
            }}
          </p>
        </section>
        <section class="border-t pt-6 space-y-4">
          <h2 class="font-medium">{{ t("settings.imageDomain") }}</h2>
          <label class="field"
            >{{ t("settings.domain") }}
            <Input
              :model-value="draft.imageOrigin ?? ''"
              @update:model-value="draft.imageOrigin = String($event)"
              type="url"
              placeholder="https://images.example.com"
              :aria-invalid="!!fields['/imageOrigin']"
              aria-describedby="domain-hint domain-error"
            />
          </label>
          <p
            v-if="fields['/imageOrigin']"
            id="domain-error"
            class="text-sm text-destructive"
          >
            {{ fields["/imageOrigin"] }}
          </p>
          <p id="domain-hint" class="subtle">{{ t("settings.domainHint") }}</p>
          <p class="subtle">{{ t("settings.domainEffect") }}</p>
        </section>
        <section class="border-t pt-6 space-y-4">
          <h2 class="font-medium">{{ t("settings.hotlink") }}</h2>
          <label class="flex items-center gap-2 text-sm"
            ><input
              v-model="draft.hotlinkEnabled"
              type="checkbox"
              class="accent-primary"
            />{{ t("settings.enable") }}</label
          >
          <div v-if="draft.hotlinkEnabled" class="space-y-4">
            <label class="field"
              >{{ t("settings.hosts") }}
              <textarea
                v-model="domains"
                rows="4"
                class="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="example.com&#10;*.example.com"
                :aria-invalid="!!fields['/hotlinkAllowedHosts']"
                aria-describedby="hosts-hint hosts-error"
              />
            </label>
            <p
              v-if="fields['/hotlinkAllowedHosts']"
              id="hosts-error"
              class="text-sm text-destructive"
            >
              {{ fields["/hotlinkAllowedHosts"] }}
            </p>
            <p id="hosts-hint" class="subtle">{{ t("settings.hostsHint") }}</p>
            <label class="flex items-center gap-2 text-sm"
              ><input
                v-model="draft.hotlinkAllowEmpty"
                type="checkbox"
                class="accent-primary"
              />{{ t("settings.empty") }}</label
            >
            <p class="subtle">{{ t("settings.emptyHint") }}</p>
            <p class="subtle">{{ t("settings.limitations") }}</p>
          </div>
        </section>
        <section class="border-t pt-6 space-y-4">
          <h2 class="font-medium">{{ t("settings.cache") }}</h2>
          <label class="field"
            >{{ t("settings.uploadTemp") }}
            <Input
              :model-value="draft.uploadTempBytes / 1048576"
              @update:model-value="
                draft.uploadTempBytes = Math.round(Number($event) * 1048576)
              "
              type="number"
              min="0.001"
              step="any"
              required
              :aria-invalid="!!fields['/uploadTempBytes']"
              aria-describedby="uploadTempBytes-hint uploadTempBytes-error"
            />
          </label>
          <p
            v-if="fields['/uploadTempBytes']"
            id="uploadTempBytes-error"
            class="text-sm text-destructive"
          >
            {{ fields["/uploadTempBytes"] }}
          </p>
          <p id="uploadTempBytes-hint" class="subtle">
            {{ t("settings.temporaryHint") }}
          </p>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1">
              <label class="field"
                >{{ t("settings.cacheCapacity") }}
                <Input
                  :model-value="draft.cacheBytes / 1048576"
                  @update:model-value="
                    draft.cacheBytes = Number($event) * 1048576
                  "
                  type="number"
                  min="1"
                  step="1"
                  required
                  :aria-invalid="!!fields['/cacheBytes']"
                />
              </label>
              <p v-if="fields['/cacheBytes']" class="text-sm text-destructive">
                {{ fields["/cacheBytes"] }}
              </p>
            </div>
            <div class="space-y-1">
              <label class="field"
                >{{ t("settings.cacheRetention") }}
                <Input
                  :model-value="draft.cacheTtlMs / 60000"
                  @update:model-value="
                    draft.cacheTtlMs = Number($event) * 60000
                  "
                  type="number"
                  min="1"
                  step="1"
                  required
                  :aria-invalid="!!fields['/cacheTtlMs']"
                />
              </label>
              <p v-if="fields['/cacheTtlMs']" class="text-sm text-destructive">
                {{ fields["/cacheTtlMs"] }}
              </p>
            </div>
          </div>
          <p class="subtle">{{ t("settings.localCacheHint") }}</p>
          <label class="field"
            >{{ t("settings.cacheAge") }}
            <Input
              v-model.number="draft.imageCacheMaxAge"
              type="number"
              min="0"
              step="1"
              required
              :aria-invalid="!!fields['/imageCacheMaxAge']"
              aria-describedby="cache-hint cache-error"
            />
          </label>
          <p
            v-if="fields['/imageCacheMaxAge']"
            id="cache-error"
            class="text-sm text-destructive"
          >
            {{ fields["/imageCacheMaxAge"] }}
          </p>
          <p id="cache-hint" class="subtle">{{ t("settings.cacheHint") }}</p>
        </section>
      </fieldset>
      <p v-if="siteLink" class="mt-5 text-sm">
        <a :href="siteLink" class="text-primary underline">{{
          t("settings.openSite")
        }}</a>
      </p>
      <p v-if="error" role="alert" class="error-box mt-5">{{ error }}</p>
      <div class="mt-7 flex items-center gap-4 border-t pt-5">
        <Button type="submit" :loading="busy">{{ t("ui.save") }}</Button>
        <p class="subtle">{{ t("settings.live") }}</p>
      </div>
    </form>
  </div>
</template>
