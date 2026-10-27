<script setup lang="ts">
import { t } from "@/lib/i18n";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { LogOut, ShieldCheck } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, clearSession, errorText, notify, session } from "@/lib/api";
const signingOut = ref(false);
const oldPassword = ref(""),
  password = ref(""),
  confirm = ref(""),
  error = ref(""),
  busy = ref(false),
  router = useRouter();
async function logout() {
  if (busy.value) return;
  signingOut.value = true;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/auth/logout", { method: "POST" });
    clearSession();
    await router.replace("/login");
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function change() {
  if (busy.value) return;
  signingOut.value = false;
  error.value = "";
  if (password.value !== confirm.value) {
    error.value = t("ui.passwordsDoNotMatch");
    return;
  }
  busy.value = true;
  try {
    await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({
        oldPassword: oldPassword.value,
        password: password.value,
      }),
    });
    oldPassword.value = password.value = confirm.value = "";
    clearSession();
    notify({ key: "ui.passwordChangedSignInAgain" });
    await router.replace("/login");
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="max-w-xl">
    <header class="page-header">
      <div class="min-w-0">
        <h1 class="page-heading">{{ t("ui.account") }}</h1>
        <p class="mt-2 subtle">
          {{ t("account.signedInAs", { name: session?.user.username ?? "" }) }}
        </p>
      </div>
    </header>
    <form class="form-section border-b pb-6" @submit.prevent="change">
      <h2 class="section-heading flex items-center gap-2">
        <ShieldCheck :size="18" />{{ t("ui.changePassword") }}
      </h2>
      <p class="subtle">
        {{ t("ui.changingYourPasswordRevokesAllSessionsAnd") }}
      </p>
      <label class="field"
        >{{ t("ui.currentPassword")
        }}<Input
          v-model="oldPassword"
          required
          type="password"
          autocomplete="current-password" /></label
      ><label class="field"
        >{{ t("ui.newPassword")
        }}<Input
          v-model="password"
          required
          minlength="6"
          type="password"
          autocomplete="new-password"
          :placeholder="t('ui.atLeast6Characters')" /></label
      ><label class="field"
        >{{ t("ui.confirmPassword")
        }}<Input
          v-model="confirm"
          required
          minlength="6"
          type="password"
          autocomplete="new-password"
      /></label>
      <p v-if="error" role="alert" class="error-box">{{ error }}</p>
      <Button type="submit" :disabled="busy" :loading="busy && !signingOut">{{
        busy && !signingOut ? t("ui.saving") : t("ui.changePassword")
      }}</Button>
    </form>
    <Button
      variant="outline"
      class="mt-6"
      :disabled="busy"
      :loading="busy && signingOut"
      @click="logout"
      ><LogOut v-if="!busy || !signingOut" />{{
        busy && signingOut ? t("ui.signingOut") : t("ui.signOut")
      }}</Button
    >
  </div>
</template>
