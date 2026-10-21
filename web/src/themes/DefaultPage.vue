<script setup lang="ts">
import { ref, onUnmounted, computed } from "vue";
import type { ThemeContext } from "../../../theme-sdk";
import { t } from "../lib/i18n";
import { size } from "../lib/utils";
const props = defineProps<{ context: ThemeContext }>();
const ctx = props.context,
  s = ref(ctx.getSnapshot());
const stop = ctx.subscribe((value) => {
  s.value = value;
});
onUnmounted(stop);
const input = ref<HTMLInputElement>(),
  username = ref(""),
  password = ref(""),
  dragging = ref(false);
const profile = computed(() =>
  s.value.profiles.find(
    (p) => p.id === s.value.selectedProfileId && p.available,
  ),
);
function files(list: FileList | null) {
  if (list) ctx.uploads.add(Array.from(list));
}
function paste(e: ClipboardEvent) {
  if (
    s.value.page !== "home" ||
    (e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")
  )
    return;
  if (e.clipboardData?.files.length) {
    e.preventDefault();
    files(e.clipboardData.files);
    return;
  }
  const urls = e.clipboardData?.getData("text/plain").trim().split(/\s+/);
  if (
    urls?.length &&
    urls.every((u) => {
      try {
        return ["http:", "https:"].includes(new URL(u).protocol);
      } catch {
        return false;
      }
    })
  ) {
    e.preventDefault();
    ctx.uploads.addUrls(urls);
  }
}
window.addEventListener("paste", paste);
onUnmounted(() => window.removeEventListener("paste", paste));
async function login() {
  const value = password.value;
  password.value = "";
  await ctx.login(username.value, value);
}
</script>
<template>
  <div class="min-h-screen bg-background text-foreground">
    <header
      class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-6"
    >
      <a
        href="/"
        class="flex items-center gap-2 text-lg font-semibold"
        @click.prevent="ctx.navigate('home')"
        ><img
          v-if="s.site.logoUrl"
          :src="s.site.logoUrl"
          alt=""
          class="size-8"
        />{{ s.site.name }}</a
      >
      <div class="flex items-center gap-4">
        <select
          v-if="s.locales.length > 1"
          :value="s.locale"
          :aria-label="t('themes.language')"
          @change="ctx.setLocale(($event.target as HTMLSelectElement).value)"
          class="native-select"
        >
          <option
            v-for="language in s.languages"
            :key="language.tag"
            :value="language.tag"
          >
            {{ language.name }}
          </option>
        </select>
        <select
          :value="s.mode"
          :aria-label="t('themes.mode')"
          @change="
            ctx.setMode(
              ($event.target as HTMLSelectElement).value as
                | 'light'
                | 'dark'
                | 'auto',
            )
          "
          class="native-select"
        >
          <option value="auto">{{ t("themes.auto") }}</option>
          <option value="light">{{ t("ui.lightMode") }}</option>
          <option value="dark">{{ t("ui.darkMode") }}</option>
        </select>
        <a
          v-if="s.page === 'home'"
          :href="s.user ? '/app/images' : '/login?return=/app/images'"
          @click.prevent="ctx.navigate(s.user ? 'app' : 'login')"
          >{{ s.user ? t("ui.app") : t("ui.signIn") }}
          <span aria-hidden="true">→</span></a
        >
      </div>
    </header>
    <main
      v-if="s.page === 'home'"
      class="mx-auto max-w-3xl px-5 py-12 sm:py-20"
    >
      <div
        v-if="s.site.homeTitle || s.site.description"
        class="mb-10 text-center"
      >
        <h1
          v-if="s.site.homeTitle"
          class="text-3xl font-semibold tracking-tight sm:text-4xl"
        >
          {{ s.site.homeTitle }}
        </h1>
        <p v-if="s.site.description" class="mt-4 text-muted-foreground">
          {{ s.site.description }}
        </p>
      </div>
      <p v-if="s.loading" class="subtle">{{ t("ui.loading") }}</p>
      <p v-if="s.error" class="error-box">
        {{ s.error }}
        <button @click="ctx.refresh()">{{ t("ui.retry") }}</button>
      </p>
      <div class="space-y-6">
        <div
          class="cursor-pointer rounded-2xl border-2 border-dashed px-6 py-16 text-center"
          :class="dragging ? 'border-primary bg-primary/5' : 'border-border'"
          role="button"
          tabindex="0"
          :aria-label="t('ui.dropImagesHere')"
          :aria-disabled="!profile"
          @click="profile && input?.click()"
          @keydown.enter.self.prevent="profile && input?.click()"
          @keydown.space.self.prevent="profile && input?.click()"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="
            dragging = false;
            files($event.dataTransfer?.files ?? null);
          "
        >
          <p class="mb-2 font-medium">{{ t("ui.dropImagesHere") }}</p>
          <p class="mb-5 text-sm text-muted-foreground">
            {{ t("ui.orPasteFromYourClipboard") }}
          </p>
          <button
            class="rounded-lg bg-primary px-5 py-2 text-primary-foreground disabled:opacity-50"
            :disabled="!profile"
            @click.stop="input?.click()"
          >
            {{ t("ui.chooseFiles") }}
          </button>
          <input
            ref="input"
            type="file"
            data-testid="upload-input"
            accept="image/*"
            multiple
            hidden
            @click.stop
            @change="
              files(input?.files ?? null);
              if (input) input.value = '';
            "
          />
          <p v-if="profile" class="mt-4 text-xs text-muted-foreground">
            {{ t("uploads.limit", { size: size(profile.maxUploadBytes) }) }} ·
            {{ profile.allowedMimeTypes.join(" / ") }}
          </p>
        </div>
        <label class="field"
          >{{ t("ui.uploadProfile")
          }}<select
            class="native-select"
            :aria-label="t('ui.uploadProfile')"
            :value="s.selectedProfileId"
            @change="
              ctx.selectProfile(($event.target as HTMLSelectElement).value)
            "
          >
            <option value="" disabled>{{ t("ui.selectAProfile") }}</option>
            <option
              v-for="p in s.profiles"
              :key="p.id"
              :value="p.id"
              :disabled="!p.available"
            >
              {{ p.name }}{{ p.reason ? " · " + p.reason : "" }}
            </option>
          </select></label
        >
        <p v-if="!s.loading && !profile" class="error-box">
          {{
            s.profiles.some((p) => p.available)
              ? t("profiles.required")
              : !s.user
                ? t("users.guestUnavailable")
                : t("users.noProfiles")
          }}
        </p>
        <div class="flex flex-wrap items-center gap-4 border-b pb-6">
          <label class="field flex-1"
            >{{ t("uploads.copyFormat")
            }}<select
              class="native-select"
              :aria-label="t('uploads.copyFormat')"
              :value="s.copy.format"
              @change="
                ctx.links.setPreferences(
                  ($event.target as HTMLSelectElement).value,
                  s.copy.auto,
                )
              "
            >
              <option v-for="f in s.copy.formats" :key="f">{{ f }}</option>
            </select></label
          >
          <label
            ><input
              type="checkbox"
              :checked="s.copy.auto"
              @change="
                ctx.links.setPreferences(
                  s.copy.format,
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />
            {{ t("uploads.autoCopy") }}</label
          >
        </div>
        <div v-if="s.uploads.length" class="space-y-3">
          <h2>
            {{ t("ui.uploadQueue") }} ·
            {{ s.uploads.filter((u) => u.status === "success").length }} /
            {{ s.uploads.length }}
          </h2>
          <button @click="ctx.links.copyAll()">
            {{ t("uploads.copyAll") }}
          </button>
          <div
            v-for="u in s.uploads"
            :key="u.id"
            class="rounded-lg border p-3"
            data-testid="upload-row"
          >
            <p class="truncate">{{ u.name }}</p>
            <p class="text-xs text-muted-foreground">
              {{ u.sourceUrl ? t("uploads.fromUrl") : size(u.size) }} ·
              {{ u.profileName }}
            </p>
            <p class="mt-2 text-xs" aria-live="polite">
              {{
                u.error ||
                {
                  queued: t("ui.queued"),
                  uploading: t("uploads.progress", { progress: u.progress }),
                  processing: t("ui.processingOnServer"),
                  success: t("ui.uploaded"),
                  cancelled: t("uploads.cancelled"),
                  failed: "",
                }[u.status]
              }}
            </p>
            <progress
              v-if="u.status === 'uploading'"
              :value="u.progress"
              max="100"
              :aria-label="t('ui.uploadProgress')"
              class="w-full"
            />
            <div class="mt-2 flex gap-3">
              <button
                v-if="u.status === 'failed' && u.resumable"
                @click="ctx.uploads.resume(u.id)"
              >
                {{ t("uploads.continue") }}</button
              ><button
                v-if="['queued', 'uploading'].includes(u.status)"
                @click="ctx.uploads.cancel(u.id)"
              >
                {{ t("ui.cancel") }}</button
              ><button
                v-if="['failed', 'cancelled'].includes(u.status)"
                @click="ctx.uploads.dismiss(u.id)"
              >
                {{ t("uploads.dismiss") }}
              </button>
            </div>
            <div
              v-if="u.result"
              role="group"
              :aria-label="t('ui.copy')"
              class="mt-3 flex flex-wrap gap-2"
            >
              <select
                class="native-select"
                :aria-label="t('uploads.copyFormat')"
                :value="s.copy.format"
                @change="
                  ctx.links.setPreferences(
                    ($event.target as HTMLSelectElement).value,
                    s.copy.auto,
                  )
                "
              >
                <option v-for="format in s.copy.formats" :key="format">
                  {{ format }}
                </option></select
              ><input
                class="native-select min-w-0 flex-1"
                readonly
                :value="ctx.links.format(u.result.url)"
                :aria-label="t('uploads.result')"
              /><button @click="ctx.links.copy(u.result!.url)">
                {{ t("ui.copy") }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
    <main v-else class="mx-auto max-w-sm px-5 py-12">
      <p
        v-if="s.site.description"
        class="mb-5 text-center text-muted-foreground"
      >
        {{ s.site.description }}
      </p>
      <form class="panel space-y-6 p-7" @submit.prevent="login">
        <h1 class="text-xl font-semibold">{{ t("ui.signIn") }}</h1>
        <p v-if="s.login.expired" class="subtle">
          {{ t("ui.sessionExpiredSignInAgain") }}
        </p>
        <p v-if="s.login.unavailable" class="error-box">
          {{ t("ui.cannotReachTheServerTryAgain") }}
        </p>
        <label class="field"
          >{{ t("ui.username")
          }}<input
            v-model="username"
            class="native-select"
            autocomplete="username"
            required
        /></label>
        <label class="field"
          >{{ t("ui.password")
          }}<input
            v-model="password"
            class="native-select"
            type="password"
            autocomplete="current-password"
            required
        /></label>
        <p v-if="s.login.error" role="alert" class="error-box">
          {{ s.login.error }}
        </p>
        <button
          class="w-full rounded-lg bg-primary px-5 py-2 text-primary-foreground"
          type="submit"
          :disabled="s.login.busy"
        >
          {{ s.login.busy ? t("ui.signingIn") : t("ui.signIn") }}
        </button>
      </form>
    </main>
    <div
      v-if="s.notice"
      role="status"
      class="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border bg-card px-5 py-3"
    >
      {{ s.notice }}
    </div>
  </div>
</template>
