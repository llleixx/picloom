<script setup lang="ts">
import { t } from "@/lib/i18n";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowRight, LoaderCircle } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  ApiError,
  errorText,
  getSession,
  clearPrivateQueries,
} from "@/lib/api";
import { safeReturn } from "@/router";
import SiteBrand from "@/components/SiteBrand.vue";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useSite } from "@/lib/site";
const { description } = useSite();
const username = ref(""),
  password = ref(""),
  error = ref(""),
  busy = ref(false);
const route = useRoute(),
  router = useRouter();
async function login() {
  busy.value = true;
  error.value = "";
  try {
    await api(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          username: username.value,
          password: password.value,
        }),
      },
      false,
    );
    password.value = "";
    clearPrivateQueries();
    await getSession();
    await router.replace(safeReturn(route.query.return));
  } catch (e) {
    error.value =
      e instanceof ApiError && e.status === 401
        ? t("ui.incorrectUsernameOrPassword")
        : errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="grid min-h-screen place-items-center p-6">
    <div class="w-full max-w-sm">
      <div
        class="mb-9 flex items-center justify-center gap-3 text-xl font-semibold"
      >
        <SiteBrand />
      </div>
      <p class="mb-5 text-center text-sm text-muted-foreground">
        {{ description }}
      </p>
      <div class="mb-5 flex justify-center"><LanguageSwitcher /></div>
      <form class="panel space-y-6 p-7 shadow-sm" @submit.prevent="login">
        <div>
          <h1 class="text-xl font-semibold">{{ t("ui.signIn") }}</h1>
        </div>
        <p v-if="route.query.expired" class="subtle">
          {{ t("ui.sessionExpiredSignInAgain") }}
        </p>
        <p v-if="route.query.unavailable" class="error-box">
          {{ t("ui.cannotReachTheServerTryAgain") }}
        </p>
        <label class="field"
          >{{ t("ui.username")
          }}<Input
            v-model="username"
            autocomplete="username"
            required
            :placeholder="t('ui.username')"
        /></label>
        <label class="field"
          >{{ t("ui.password")
          }}<Input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            :placeholder="t('ui.password')"
        /></label>
        <p v-if="error" role="alert" class="error-box">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="busy"
          ><LoaderCircle v-if="busy" class="animate-spin" :size="16" />{{
            busy ? t("ui.signingIn") : t("ui.signIn")
          }}<ArrowRight v-if="!busy" :size="16"
        /></Button>
      </form>
    </div>
  </main>
</template>
