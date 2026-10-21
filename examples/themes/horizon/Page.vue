<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ArrowUpRight,
  ArrowRight,
  Upload,
  Image,
  Check,
  Copy,
  Pause,
  Play,
  ChevronLeft,
  ChevronRight,
  X,
  LoaderCircle,
  Link,
} from "lucide-vue-next";
import type { Config, ThemeContext } from "../../../theme-sdk";
const { context: ctx } = defineProps<{ context: ThemeContext }>();
const state = ref(ctx.getSnapshot());
const stop = ctx.subscribe((value) => {
  state.value = value;
});
function background(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  return /^https?:\/\//i.test(value) ? value : ctx.asset(value);
}
const scenes = (
  Array.isArray(ctx.config.backgrounds) ? ctx.config.backgrounds : []
)
  .filter(
    (item): item is Config =>
      !!item && typeof item === "object" && !Array.isArray(item),
  )
  .map((item) => ({
    url: background(item.url),
    name: item.name,
    tone: item.tone,
  }))
  .filter((scene) => scene.url);
const current = ref(0),
  ready = ref<boolean[]>(scenes.map(() => false));
const availableScenes = computed(() =>
  scenes.flatMap((scene, index) =>
    ready.value[index] ? [{ ...scene, index }] : [],
  ),
);
const currentScene = computed(() => scenes[current.value]);
const sceneNumber = computed(() =>
  String(
    availableScenes.value.findIndex((scene) => scene.index === current.value) +
      1,
  ).padStart(2, "0"),
);
function sceneName(scene: (typeof scenes)[number], index: number) {
  return (
    ctx.localized(scene.name) ||
    ctx.t("backgroundName", { number: String(index + 1).padStart(2, "0") })
  );
}
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const paused = ref(reduced.matches || ctx.config.rotate === false);
const hidden = ref(document.hidden);
const input = ref<HTMLInputElement>(),
  drag = ref(false),
  username = ref(""),
  password = ref("");
const urlMode = ref(false),
  remoteUrl = ref("");
const profile = computed(() =>
  state.value.profiles.find(
    (p) => p.id === state.value.selectedProfileId && p.available,
  ),
);
const interval = Number(ctx.config.interval) * 1000;
let timer: ReturnType<typeof setInterval>;
function resetTimer() {
  clearInterval(timer);
  if (availableScenes.value.length <= 1) return;
  timer = setInterval(() => {
    if (!paused.value && !hidden.value) next();
  }, interval);
}
watch(() => availableScenes.value.length, resetTimer);
function switchScene(index: number) {
  if (ready.value[index]) {
    current.value = index;
    resetTimer();
  }
}
function next(step = 1) {
  for (let offset = 1; offset <= scenes.length; offset++) {
    const index =
      (current.value + step * offset + scenes.length) % scenes.length;
    if (ready.value[index]) {
      switchScene(index);
      return;
    }
  }
}
function visibility() {
  hidden.value = document.hidden;
}
function motion() {
  if (reduced.matches) paused.value = true;
}
function files(list: FileList | null | undefined) {
  if (list?.length && profile.value) ctx.uploads.add(Array.from(list));
}
function paste(e: ClipboardEvent) {
  if (
    state.value.page !== "home" ||
    (e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")
  )
    return;
  if (e.clipboardData?.files.length) {
    e.preventDefault();
    files(e.clipboardData.files);
  }
}
function addUrl() {
  const value = remoteUrl.value.trim();
  if (!value || !profile.value) return;
  ctx.uploads.addUrls(value.split(/\s+/));
  remoteUrl.value = "";
  urlMode.value = false;
}
async function login() {
  const value = password.value;
  password.value = "";
  await ctx.login(username.value, value);
}
function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}
onMounted(() => {
  resetTimer();
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("paste", paste);
  reduced.addEventListener("change", motion);
});
onUnmounted(() => {
  stop();
  clearInterval(timer);
  document.removeEventListener("visibilitychange", visibility);
  window.removeEventListener("paste", paste);
  reduced.removeEventListener("change", motion);
});
</script>
<template>
  <div
    class="horizon"
    :class="{ 'hz-night': currentScene?.tone === 'night' }"
    :style="{ '--shade': String(ctx.config.shade) }"
  >
    <div class="hz-scenery" aria-hidden="true">
      <img
        v-for="(scene, index) in scenes"
        :key="index"
        :src="scene.url || undefined"
        alt=""
        :class="{ visible: current === index && ready[index] }"
        @load="
          ready[index] = true;
          if (!ready[current]) current = index;
        "
        @error="
          ready[index] = false;
          if (current === index) next();
        "
      />
    </div>
    <div class="hz-scrim" aria-hidden="true"></div>
    <div class="hz-layout">
      <header class="hz-header">
        <a class="hz-brand" href="/" @click.prevent="ctx.navigate('home')"
          ><img
            v-if="state.site.logoUrl"
            :src="state.site.logoUrl"
            alt=""
          /><span>{{ state.site.name }}</span
          ><span class="hz-brand-divider"></span
          ><span class="hz-edition">HORIZON</span></a
        >
        <nav class="hz-nav" :aria-label="ctx.t('navigation')">
          <select
            v-if="state.locales.length > 1"
            :value="state.locale"
            :aria-label="ctx.t('language')"
            @change="ctx.setLocale(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="lang in state.languages"
              :key="lang.tag"
              :value="lang.tag"
            >
              {{ lang.name }}
            </option>
          </select>
          <a
            class="hz-nav-link"
            :href="
              state.user
                ? '/app/images'
                : state.page === 'home'
                  ? '/login'
                  : '/'
            "
            @click.prevent="
              ctx.navigate(
                state.user ? 'app' : state.page === 'home' ? 'login' : 'home',
              )
            "
            >{{
              ctx.t(
                state.user ? "app" : state.page === "home" ? "login" : "home",
              )
            }}<ArrowUpRight :size="16"
          /></a>
        </nav>
      </header>
      <main class="hz-main">
        <section class="hz-story">
          <div class="hz-eyebrow">
            <span></span
            >{{ ctx.t(state.page === "home" ? "eyebrow" : "welcome") }}
          </div>
          <h1
            v-if="
              state.page === 'home'
                ? ctx.localized(ctx.config.heading)
                : ctx.localized(ctx.config.loginHeading)
            "
          >
            {{
              state.page === "home"
                ? ctx.localized(ctx.config.heading)
                : ctx.localized(ctx.config.loginHeading)
            }}
          </h1>
          <p
            v-if="
              state.page === 'home'
                ? ctx.localized(ctx.config.description)
                : ctx.localized(ctx.config.loginDescription)
            "
            class="hz-description"
          >
            {{
              state.page === "home"
                ? ctx.localized(ctx.config.description)
                : ctx.localized(ctx.config.loginDescription)
            }}
          </p>
          <div class="hz-story-note">
            <span class="hz-line"></span>{{ ctx.t("note") }}
          </div>
        </section>
        <section
          class="hz-panel"
          :aria-label="ctx.t(state.page === 'home' ? 'upload' : 'login')"
        >
          <div class="hz-panel-heading">
            <span class="hz-panel-symbol"
              ><Image v-if="state.page === 'home'" :size="19" /><ArrowRight
                v-else
                :size="19" /></span
            ><span>{{ ctx.t(state.page === "home" ? "upload" : "login") }}</span
            ><span class="hz-panel-number">{{
              state.page === "home" ? "01 / UPLOAD" : "02 / WELCOME"
            }}</span>
          </div>
          <template v-if="state.page === 'home'">
            <p class="hz-panel-intro">{{ ctx.t("uploadIntro") }}</p>
            <div
              class="hz-drop"
              :class="{ 'is-dragging': drag, 'is-disabled': !profile }"
              role="button"
              tabindex="0"
              :aria-label="ctx.t('choose')"
              :aria-disabled="!profile"
              @click="profile && input?.click()"
              @keydown.enter.self.prevent="profile && input?.click()"
              @keydown.space.self.prevent="profile && input?.click()"
              @dragover.prevent="drag = true"
              @dragleave.prevent="drag = false"
              @drop.prevent="
                drag = false;
                files($event.dataTransfer?.files);
              "
            >
              <div class="hz-upload-mark">
                <Upload :size="27" :stroke-width="1.3" />
              </div>
              <strong>{{ ctx.t("drop") }}</strong
              ><span>{{ ctx.t("paste") }}</span>
              <span class="hz-choose"
                >{{ ctx.t("choose") }}<ArrowUpRight :size="16"
              /></span>
              <input
                ref="input"
                type="file"
                accept="image/*"
                multiple
                hidden
                @click.stop
                @change="
                  files(input?.files);
                  if (input) input.value = '';
                "
              />
            </div>
            <div class="hz-profile">
              <label for="hz-profile">{{ ctx.t("profile") }}</label
              ><select
                id="hz-profile"
                :value="state.selectedProfileId"
                @change="
                  ctx.selectProfile(($event.target as HTMLSelectElement).value)
                "
              >
                <option disabled value="">
                  {{ ctx.t(state.loading ? "loading" : "selectProfile") }}
                </option>
                <option
                  v-for="p in state.profiles"
                  :key="p.id"
                  :value="p.id"
                  :disabled="!p.available"
                >
                  {{ p.name
                  }}{{
                    !p.available
                      ? " · " + (p.reason || ctx.t("unavailable"))
                      : ""
                  }}
                </option>
              </select>
            </div>
            <p v-if="state.error" class="hz-error" role="alert">
              {{ state.error }}
              <button @click="ctx.refresh()">{{ ctx.t("retry") }}</button>
            </p>
            <p v-else-if="!state.loading && !profile" class="hz-help">
              {{ ctx.t(state.user ? "noProfile" : "guest") }}
              <button v-if="!state.user" @click="ctx.navigate('login')">
                {{ ctx.t("login") }} →
              </button>
            </p>
            <div class="hz-meta">
              <span>{{
                profile
                  ? size(profile.maxUploadBytes) + " / " + ctx.t("perFile")
                  : ctx.t("ready")
              }}</span
              ><button :aria-expanded="urlMode" @click="urlMode = !urlMode">
                <Link :size="13" />{{ ctx.t("fromUrl") }}
              </button>
            </div>
            <form v-if="urlMode" class="hz-url" @submit.prevent="addUrl">
              <input
                v-model="remoteUrl"
                type="url"
                required
                placeholder="https://…"
                :aria-label="ctx.t('fromUrl')"
              /><button :disabled="!profile" :aria-label="ctx.t('upload')">
                <ArrowRight :size="18" />
              </button>
            </form>
            <details class="hz-options">
              <summary>{{ ctx.t("options") }}</summary>
              <div>
                <select
                  :aria-label="ctx.t('copyFormat')"
                  :value="state.copy.format"
                  @change="
                    ctx.links.setPreferences(
                      ($event.target as HTMLSelectElement).value,
                      state.copy.auto,
                    )
                  "
                >
                  <option v-for="format in state.copy.formats" :key="format">
                    {{ format }}
                  </option></select
                ><label
                  ><input
                    type="checkbox"
                    :checked="state.copy.auto"
                    @change="
                      ctx.links.setPreferences(
                        state.copy.format,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />{{ ctx.t("autoCopy") }}</label
                >
              </div>
            </details>
            <div
              v-if="state.uploads.length"
              class="hz-queue"
              aria-live="polite"
            >
              <div class="hz-queue-header">
                <span
                  >{{ ctx.t("queue") }} ·
                  {{
                    state.uploads.filter((u) => u.status === "success").length
                  }}
                  / {{ state.uploads.length }}</span
                ><button @click="ctx.links.copyAll()">
                  {{ ctx.t("copyAll") }}
                </button>
              </div>
              <article
                v-for="item in state.uploads"
                :key="item.id"
                class="hz-item"
              >
                <div class="hz-item-top">
                  <Check
                    v-if="item.status === 'success'"
                    :size="15"
                    class="hz-success"
                  /><LoaderCircle
                    v-else-if="
                      ['uploading', 'processing'].includes(item.status)
                    "
                    class="hz-spin"
                    :size="15"
                  /><Image v-else :size="15" /><span :title="item.name">{{
                    item.name
                  }}</span
                  ><button
                    v-if="item.result"
                    :aria-label="ctx.t('copy')"
                    @click="ctx.links.copy(item.result!.url)"
                  >
                    <Copy :size="14" /></button
                  ><button
                    v-if="['queued', 'uploading'].includes(item.status)"
                    :aria-label="ctx.t('cancel')"
                    @click="ctx.uploads.cancel(item.id)"
                  >
                    <X :size="14" /></button
                  ><button
                    v-if="['failed', 'cancelled'].includes(item.status)"
                    :aria-label="ctx.t('dismiss')"
                    @click="ctx.uploads.dismiss(item.id)"
                  >
                    <X :size="14" />
                  </button>
                </div>
                <p :class="{ 'hz-error': item.status === 'failed' }">
                  {{ item.error || ctx.t(item.status)
                  }}{{
                    item.status === "uploading"
                      ? " · " + item.progress + "%"
                      : ""
                  }}
                  <button
                    v-if="item.resumable"
                    @click="ctx.uploads.resume(item.id)"
                  >
                    {{ ctx.t("retry") }}
                  </button>
                </p>
                <progress
                  v-if="item.status === 'uploading'"
                  :value="item.progress"
                  max="100"
                  :aria-label="ctx.t('uploading')"
                /><input
                  v-if="item.result"
                  class="hz-result"
                  readonly
                  :value="ctx.links.format(item.result.url)"
                  :aria-label="ctx.t('result')"
                  @focus="($event.target as HTMLInputElement).select()"
                />
              </article>
            </div>
          </template>
          <form v-else class="hz-login" @submit.prevent="login">
            <p class="hz-panel-intro">{{ ctx.t("loginIntro") }}</p>
            <p v-if="state.login.expired" class="hz-help">
              {{ ctx.t("expired") }}
            </p>
            <p v-if="state.login.unavailable" class="hz-error">
              {{ ctx.t("unavailable") }}
            </p>
            <label
              >{{ ctx.t("username")
              }}<input
                v-model="username"
                required
                autocomplete="username"
                :placeholder="ctx.t('usernamePlaceholder')" /></label
            ><label
              >{{ ctx.t("password")
              }}<input
                v-model="password"
                required
                type="password"
                autocomplete="current-password"
                :placeholder="ctx.t('passwordPlaceholder')"
            /></label>
            <p v-if="state.login.error" class="hz-error" role="alert">
              {{ state.login.error }}
            </p>
            <button
              type="submit"
              class="hz-submit"
              :disabled="state.login.busy"
            >
              <LoaderCircle
                v-if="state.login.busy"
                class="hz-spin"
                :size="17"
              />{{ ctx.t(state.login.busy ? "loading" : "login")
              }}<ArrowRight :size="17" />
            </button>
            <a href="/" class="hz-back" @click.prevent="ctx.navigate('home')">{{
              ctx.t("back")
            }}</a>
          </form>
          <div class="hz-panel-foot">
            <span class="hz-status-dot"></span>{{ ctx.t("panelFoot") }}
          </div>
        </section>
      </main>
      <footer class="hz-footer">
        <div v-if="currentScene && ready[current]" class="hz-scene-info">
          <span class="hz-scene-index"
            >{{ sceneNumber
            }}<span>
              / {{ String(availableScenes.length).padStart(2, "0") }}</span
            ></span
          >
          <div>
            <span class="hz-scene-kicker">{{ ctx.t("scenery") }}</span
            ><strong>{{ sceneName(currentScene, current) }}</strong>
          </div>
        </div>
        <div v-if="availableScenes.length > 1" class="hz-scene-controls">
          <button
            class="hz-icon"
            :aria-label="ctx.t('previous')"
            @click="next(-1)"
          >
            <ChevronLeft :size="17" /></button
          ><button
            v-for="scene in availableScenes"
            :key="scene.index"
            class="hz-scene-dot"
            :class="{ active: current === scene.index }"
            :aria-label="sceneName(scene, scene.index)"
            :aria-pressed="current === scene.index"
            @click="switchScene(scene.index)"
          >
            <span></span></button
          ><button class="hz-icon" :aria-label="ctx.t('next')" @click="next()">
            <ChevronRight :size="17" /></button
          ><span class="hz-control-divider"></span
          ><button
            class="hz-icon"
            :aria-label="ctx.t(paused ? 'play' : 'pause')"
            @click="paused = !paused"
          >
            <Play v-if="paused" :size="13" /><Pause v-else :size="13" />
          </button>
        </div>
        <span class="hz-footer-note"
          >{{ ctx.t("footer")
          }}<span>HORIZON — {{ state.site.name }}</span></span
        >
      </footer>
    </div>
    <div v-if="state.notice" role="status" class="hz-toast">
      <Check :size="16" />{{ state.notice }}
    </div>
  </div>
</template>
