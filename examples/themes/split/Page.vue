<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import type { ThemeContext } from "../../../theme-sdk";
const { context: ctx } = defineProps<{ context: ThemeContext }>();
const state = ref(ctx.getSnapshot()),
  username = ref(""),
  password = ref("");
const stop = ctx.subscribe((s) => {
  state.value = s;
});
onUnmounted(stop);
async function login() {
  const value = password.value;
  password.value = "";
  await ctx.login(username.value, value);
}
</script>
<template>
  <div
    class="split-theme"
    :class="{ dark: state.dark }"
    :style="{ '--accent': String(ctx.config.accent ?? '') }"
  >
    <aside>
      <a href="/" @click.prevent="ctx.navigate('home')"
        ><img
          v-if="state.site.logoUrl"
          :src="state.site.logoUrl"
          alt=""
          width="40"
        />{{ state.site.name }}</a
      >
      <h1 v-if="ctx.localized(ctx.config.heading)">
        {{ ctx.localized(ctx.config.heading) }}
      </h1>
      <p v-if="state.site.description">{{ state.site.description }}</p>
      <nav>
        <button @click="ctx.navigate('home')">{{ ctx.t("home") }}</button
        ><button @click="ctx.navigate(state.user ? 'app' : 'login')">
          {{ state.user ? ctx.t("app") : ctx.t("login") }}
        </button>
      </nav>
      <label v-if="state.locales.length > 1"
        >{{ ctx.t("language")
        }}<select
          :value="state.locale"
          @change="ctx.setLocale(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="lang in state.languages"
            :key="lang.tag"
            :value="lang.tag"
          >
            {{ lang.name }}
          </option>
        </select></label
      >
      <button @click="ctx.setMode(state.dark ? 'light' : 'dark')">
        {{ ctx.t("appearance") }}
      </button>
    </aside>
    <main>
      <template v-if="state.page === 'home'">
        <h2>{{ ctx.t("upload") }}</h2>
        <p v-if="state.loading">{{ ctx.t("loading") }}</p>
        <p role="alert" v-if="state.error">
          {{ state.error }}
          <button @click="ctx.refresh()">{{ ctx.t("retry") }}</button>
        </p>
        <label
          >{{ ctx.t("profile")
          }}<select
            :value="state.selectedProfileId"
            @change="
              ctx.selectProfile(($event.target as HTMLSelectElement).value)
            "
          >
            <option disabled value="">—</option>
            <option
              v-for="p in state.profiles"
              :key="p.id"
              :value="p.id"
              :disabled="!p.available"
            >
              {{ p.name }} {{ p.reason }}
            </option>
          </select></label
        >
        <label
          class="drop"
          @dragover.prevent
          @drop.prevent="
            ctx.uploads.add(Array.from($event.dataTransfer?.files ?? []))
          "
          >{{ ctx.t("choose")
          }}<input
            type="file"
            accept="image/*"
            multiple
            @change="
              ctx.uploads.add(
                Array.from(($event.target as HTMLInputElement).files ?? []),
              );
              ($event.target as HTMLInputElement).value = '';
            "
        /></label>
        <article v-for="item in state.uploads" :key="item.id">
          <strong>{{ item.name }}</strong>
          <p>{{ item.error || ctx.t(item.status) }}</p>
          <progress
            v-if="item.status === 'uploading'"
            :value="item.progress"
            max="100"
          /><button
            v-if="['queued', 'uploading'].includes(item.status)"
            @click="ctx.uploads.cancel(item.id)"
          >
            {{ ctx.t("cancel") }}</button
          ><button v-if="item.resumable" @click="ctx.uploads.resume(item.id)">
            {{ ctx.t("retry") }}</button
          ><button
            v-if="['failed', 'cancelled'].includes(item.status)"
            @click="ctx.uploads.dismiss(item.id)"
          >
            {{ ctx.t("dismiss") }}</button
          ><button v-if="item.result" @click="ctx.links.copy(item.result!.url)">
            {{ ctx.t("copy") }}
          </button>
        </article>
      </template>
      <form v-else @submit.prevent="login">
        <h2>{{ ctx.t("login") }}</h2>
        <p v-if="state.login.expired">{{ ctx.t("expired") }}</p>
        <p v-if="state.login.unavailable">{{ ctx.t("unavailable") }}</p>
        <label
          >{{ ctx.t("username")
          }}<input v-model="username" required autocomplete="username" /></label
        ><label
          >{{ ctx.t("password")
          }}<input
            v-model="password"
            required
            type="password"
            autocomplete="current-password"
        /></label>
        <p role="alert" v-if="state.login.error">{{ state.login.error }}</p>
        <button :disabled="state.login.busy">
          {{ state.login.busy ? ctx.t("loading") : ctx.t("login") }}
        </button>
      </form>
      <p role="status">{{ state.notice }}</p>
    </main>
  </div>
</template>
