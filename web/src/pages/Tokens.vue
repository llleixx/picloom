<script setup lang="ts">
import { t } from "@/lib/i18n";
import { onUnmounted, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { KeyRound, Plus, Copy } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { TokenView, UploadProfileView } from "../../../shared/api";
import { api, errorText, copy } from "@/lib/api";
import { date } from "@/lib/utils";
const tokens = useQuery({
  queryKey: ["tokens"],
  queryFn: ({ signal }) => api<TokenView[]>("/api/tokens", { signal }),
});
const profiles = useQuery({
  queryKey: ["profiles"],
  queryFn: ({ signal }) =>
    api<UploadProfileView[]>("/api/upload-profiles", { signal }),
});
const duration = ref("90"),
  customExpiry = ref(""),
  scope = ref("all"),
  profileIds = ref<string[]>([]);
const name = ref(""),
  secret = ref(""),
  error = ref(""),
  busy = ref(false),
  revokeId = ref("");
onUnmounted(() => (secret.value = ""));
async function create() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const expiresAt =
      duration.value === "never"
        ? null
        : duration.value === "custom"
          ? new Date(customExpiry.value).getTime()
          : Date.now() + Number(duration.value) * 86400000;
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    ) {
      error.value = t("tokens.futureExpiry");
      return;
    }
    if (scope.value === "selected" && !profileIds.value.length) {
      error.value = t("tokens.selectProfiles");
      return;
    }
    const value = await api<{ token: string }>("/api/tokens", {
      method: "POST",
      body: JSON.stringify({
        name: name.value,
        expiresAt,
        profileIds: scope.value === "all" ? null : profileIds.value,
      }),
    });
    secret.value = value.token;
    name.value = "";
    await tokens.refetch();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function revoke() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api("/api/tokens/" + revokeId.value, { method: "DELETE" });
    revokeId.value = "";
    await tokens.refetch();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="max-w-4xl">
    <h1 class="page-heading">{{ t("ui.uploadTokens") }}</h1>
    <p class="mt-2 mb-7 subtle">
      {{ t("ui.uploadOnlyAccessForScriptsAndApps") }}
    </p>
    <form class="mb-6 space-y-4 border-b pb-6" @submit.prevent="create">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="field min-w-0"
          >{{ t("ui.tokenName")
          }}<Input
            v-model="name"
            required
            maxlength="100"
            :placeholder="t('ui.eGBlogUploader')"
        /></label>
        <label class="field"
          >{{ t("tokens.validFor") }}
          <select v-model="duration" class="native-select">
            <option
              v-for="days in [7, 30, 90, 365]"
              :key="days"
              :value="String(days)"
            >
              {{ t("tokens.days", { count: days }) }}
            </option>
            <option value="never">{{ t("tokens.neverExpires") }}</option>
            <option value="custom">{{ t("tokens.custom") }}</option>
          </select>
        </label>
        <label v-if="duration === 'custom'" class="field"
          >{{ t("tokens.expiryDate")
          }}<Input v-model="customExpiry" type="datetime-local" required
        /></label>
        <label class="field"
          >{{ t("tokens.profileScope") }}
          <select v-model="scope" class="native-select">
            <option value="all">{{ t("tokens.allProfiles") }}</option>
            <option value="selected">{{ t("tokens.selectedProfiles") }}</option>
          </select>
        </label>
      </div>
      <fieldset v-if="scope === 'selected'" class="space-y-2">
        <legend class="mb-2 text-sm">{{ t("tokens.allowedProfiles") }}</legend>
        <p v-if="profiles.isPending.value" class="subtle">
          {{ t("ui.loading") }}
        </p>
        <div v-else-if="profiles.error.value" role="alert" class="error-box">
          {{ errorText(profiles.error.value)
          }}<Button type="button" variant="ghost" @click="profiles.refetch()">{{
            t("ui.retry")
          }}</Button>
        </div>
        <p v-else-if="!profiles.data.value?.length" class="subtle">
          {{ t("configuration.empty") }}
        </p>
        <label
          v-for="profile in profiles.data.value"
          :key="profile.id"
          class="flex items-center gap-2 text-sm"
        >
          <input v-model="profileIds" type="checkbox" :value="profile.id" />{{
            profile.name
          }}
        </label>
      </fieldset>
      <Button type="submit" :loading="busy && !revokeId" :disabled="busy"
        ><Plus v-if="!busy" />{{
          busy && !revokeId ? t("ui.creating") : t("ui.createToken")
        }}</Button
      >
    </form>
    <p v-if="error" role="alert" class="error-box mb-4">{{ error }}</p>
    <p v-if="tokens.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
    <div v-else-if="tokens.error.value" class="error-box">
      {{ errorText(tokens.error.value)
      }}<Button variant="ghost" @click="tokens.refetch()">{{
        t("ui.retry")
      }}</Button>
    </div>
    <div v-else-if="!tokens.data.value?.length" class="py-12 text-center">
      <KeyRound class="mx-auto mb-4 text-muted-foreground" :size="28" />
      <p>{{ t("ui.noTokensYet") }}</p>
      <p class="mt-2 subtle">{{ t("ui.createATokenForYourUploadTool") }}</p>
    </div>
    <div v-else class="divide-y border-y">
      <div
        v-for="token in tokens.data.value"
        :key="token.id"
        class="flex flex-wrap items-center justify-between gap-2 py-3"
      >
        <div>
          <p class="text-sm font-medium">{{ token.name }}</p>
          <p class="mt-2 text-xs text-muted-foreground">
            ••••{{ token.hint }} ·
            {{
              token.expiresAt === null
                ? t("tokens.neverExpires")
                : t("tokens.expires", { date: date(token.expiresAt) })
            }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            {{
              token.profileIds === null
                ? t("tokens.allProfiles")
                : token.profileIds
                    .map(
                      (id) =>
                        profiles.data.value?.find((p) => p.id === id)?.name ??
                        t("tokens.unavailableProfile"),
                    )
                    .join(", ")
            }}
          </p>
        </div>
        <span v-if="token.revokedAt" class="subtle">{{ t("ui.revoked") }}</span
        ><span
          v-else-if="token.expiresAt !== null && token.expiresAt <= Date.now()"
          class="subtle"
          >{{ t("ui.expired") }}</span
        ><Button
          v-else
          variant="outline"
          size="sm"
          @click="
            revokeId = token.id;
            error = '';
          "
          >{{ t("ui.revoke") }}</Button
        >
      </div>
    </div>
    <Dialog
      :open="!!secret"
      @update:open="
        (value) => {
          if (!value) secret = '';
        }
      "
      ><DialogContent
        ><DialogTitle>{{ t("ui.tokenCreated") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.copyThisTokenNowItIsShown")
        }}</DialogDescription
        ><Input
          :model-value="secret"
          readonly
          :aria-label="t('ui.newToken')"
        /><Button @click="copy(secret)"
          ><Copy />{{ t("ui.copyToken") }}</Button
        ></DialogContent
      ></Dialog
    >
    <Dialog
      :open="!!revokeId"
      @update:open="
        (value) => {
          if (!value) revokeId = '';
        }
      "
      ><DialogContent :busy="busy"
        ><DialogTitle>{{ t("ui.revokeToken") }}</DialogTitle
        ><DialogDescription>{{
          t("ui.appsUsingThisTokenWillLoseUpload")
        }}</DialogDescription>
        <p v-if="error" class="error-box">{{ error }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="revokeId = ''">{{
            t("ui.cancel")
          }}</Button
          ><Button variant="destructive" :loading="busy" @click="revoke">{{
            busy ? t("ui.revoking") : t("ui.revokeToken2")
          }}</Button>
        </div></DialogContent
      ></Dialog
    >
  </div>
</template>
