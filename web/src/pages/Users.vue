<script setup lang="ts">
import { canManageUser } from "../../../shared/roles";
import { ref, reactive, computed } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { Plus, Pencil } from "lucide-vue-next";
import { api, errorText, queryClient, session } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { UserView, UploadProfileView } from "../../../shared/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
const isOwner = computed(() => session.value?.user.role === "owner");
const canEdit = (user: UserView) =>
  canManageUser(session.value?.user.role, user.role);
const page = ref(1),
  search = ref(""),
  status = ref("");
const query = computed(() =>
  new URLSearchParams({
    limit: "30",
    offset: String((page.value - 1) * 30),
    q: search.value,
    status: status.value,
  }).toString(),
);
const users = useQuery({
  queryKey: computed(() => ["users", query.value]),
  queryFn: () =>
    api<{ items: UserView[]; total: number }>("/api/users?" + query.value),
});
const profiles = useQuery({
  queryKey: ["profiles"],
  queryFn: () => api<UploadProfileView[]>("/api/upload-profiles"),
});
const open = ref(false),
  busy = ref(false),
  error = ref("");
const draft = reactive({
  maxSizeMiB: "" as string | number,
  dailyLimit: "" as string | number,
  id: "",
  username: "",
  password: "",
  role: "member" as "admin" | "member",
  status: "active" as "active" | "disabled",
  profileIds: [] as string[],
});
function edit(user?: UserView) {
  Object.assign(draft, {
    maxSizeMiB:
      user?.maxUploadBytes == null ? "" : user.maxUploadBytes / 1048576,
    dailyLimit: user?.dailyUploadLimit ?? "",
    id: user?.id ?? "",
    username: user?.username ?? "",
    password: "",
    role: user?.role ?? "member",
    status: user?.status ?? "active",
    profileIds: [...(user?.profileIds ?? [])],
  });
  error.value = "";
  open.value = true;
}
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["users"] });
  await queryClient.invalidateQueries({ queryKey: ["profiles"] });
}
async function save() {
  busy.value = true;
  error.value = "";
  try {
    await api("/api/users" + (draft.id ? "/" + draft.id : ""), {
      method: draft.id ? "PUT" : "POST",
      body: JSON.stringify({
        maxUploadBytes:
          draft.maxSizeMiB === ""
            ? null
            : Math.round(Number(draft.maxSizeMiB) * 1048576),
        dailyUploadLimit:
          draft.dailyLimit === "" ? null : Number(draft.dailyLimit),
        username: draft.username,
        ...(!draft.id ? { password: draft.password } : {}),
        role: draft.role,
        status: draft.status,
        profileIds: draft.profileIds,
      }),
    });
    open.value = false;
    await refresh();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function resetPassword() {
  busy.value = true;
  error.value = "";
  try {
    await api(`/api/users/${draft.id}/password`, {
      method: "POST",
      body: JSON.stringify({ password: draft.password }),
    });
    draft.password = "";
    open.value = false;
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="page-heading">{{ t("users.title") }}</h1>
      <Button @click="edit()"><Plus />{{ t("ui.create") }}</Button>
    </div>
    <div class="mb-5 flex gap-3">
      <Input
        v-model="search"
        :aria-label="t('users.search')"
        :placeholder="t('users.search')"
        @update:model-value="page = 1"
      /><select
        v-model="status"
        :aria-label="t('users.status')"
        class="native-select"
        @change="page = 1"
      >
        <option value="">{{ t("users.allStatuses") }}</option>
        <option value="active">{{ t("users.active") }}</option>
        <option value="disabled">{{ t("users.disabled") }}</option>
      </select>
    </div>
    <p v-if="users.isPending.value" class="subtle">{{ t("ui.loading") }}</p>
    <p v-else-if="users.error.value" role="alert" class="error-box">
      {{ errorText(users.error.value)
      }}<Button variant="ghost" @click="users.refetch()">{{
        t("ui.retry")
      }}</Button>
    </p>
    <p v-else-if="!users.data.value?.items.length" class="subtle">
      {{ t("users.empty") }}
    </p>
    <div v-else class="divide-y border-y">
      <article
        v-for="user in users.data.value.items"
        :key="user.id"
        class="flex items-center justify-between gap-2 py-3"
      >
        <div>
          <h2 class="font-medium">{{ user.username }}</h2>
          <p class="subtle">
            {{
              user.role === "owner"
                ? t("users.owner")
                : user.role === "admin"
                  ? t("ui.administrator")
                  : t("users.member")
            }}
            ·
            {{
              user.status === "active" ? t("users.active") : t("users.disabled")
            }}
          </p>
        </div>
        <Button v-if="canEdit(user)" variant="ghost" @click="edit(user)"
          ><Pencil />{{ t("ui.edit") }}</Button
        >
      </article>
    </div>
    <div class="mt-5 flex items-center justify-end gap-3">
      <Button variant="ghost" :disabled="page === 1" @click="page--">{{
        t("users.previous")
      }}</Button
      ><span
        >{{ page }} /
        {{ Math.max(1, Math.ceil((users.data.value?.total ?? 0) / 30)) }}</span
      ><Button
        variant="ghost"
        :disabled="page * 30 >= (users.data.value?.total ?? 0)"
        @click="page++"
        >{{ t("users.next") }}</Button
      >
    </div>
    <Sheet v-model:open="open"
      ><SheetContent class="editor-sheet"
        ><SheetTitle>{{
          draft.id ? t("users.edit") : t("users.create")
        }}</SheetTitle
        ><SheetDescription>{{ t("users.description") }}</SheetDescription>
        <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="save">
          <div class="editor-body">
            <p v-if="error" role="alert" class="error-box">{{ error }}</p>
            <label class="field"
              >{{ t("ui.username")
              }}<Input
                v-model="draft.username"
                required
                maxlength="64"
                :disabled="!!draft.id"
                autocomplete="off"
            /></label>
            <label v-if="!draft.id" class="field"
              >{{ t("ui.password")
              }}<Input
                v-model="draft.password"
                type="password"
                required
                minlength="12"
                autocomplete="new-password"
            /></label>
            <label class="field"
              >{{ t("users.role")
              }}<select
                v-model="draft.role"
                class="native-select"
                :disabled="!isOwner"
              >
                <option value="member">{{ t("users.member") }}</option>
                <option v-if="isOwner" value="admin">
                  {{ t("ui.administrator") }}
                </option>
              </select></label
            >
            <label class="field"
              >{{ t("users.status")
              }}<select v-model="draft.status" class="native-select">
                <option value="active">{{ t("users.active") }}</option>
                <option value="disabled">{{ t("users.disabled") }}</option>
              </select></label
            >
            <label class="field"
              >{{ t("limits.maxSize")
              }}<Input
                v-model="draft.maxSizeMiB"
                type="number"
                min="0.001"
                step="any"
                :placeholder="t('limits.unlimited')"
            /></label>
            <label class="field"
              >{{ t("limits.daily")
              }}<Input
                v-model="draft.dailyLimit"
                type="number"
                min="0"
                step="1"
                :placeholder="t('limits.unlimited')"
            /></label>
            <p class="subtle">{{ t("limits.hint") }}</p>
            <fieldset v-if="draft.role === 'member'" class="space-y-3">
              <legend class="mb-2 font-medium">
                {{ t("ui.uploadProfiles") }}
              </legend>
              <p class="subtle">{{ t("users.profileHint") }}</p>
              <label
                v-for="profile in profiles.data.value"
                :key="profile.id"
                class="flex items-center gap-2"
                ><input
                  v-model="draft.profileIds"
                  type="checkbox"
                  :value="profile.id"
                />{{ profile.name }}</label
              >
            </fieldset>
            <div v-if="draft.id" class="space-y-3 border-t pt-5">
              <label class="field"
                >{{ t("users.newPassword")
                }}<Input
                  v-model="draft.password"
                  type="password"
                  minlength="12"
                  autocomplete="new-password"
              /></label>
              <p class="subtle">{{ t("users.resetHint") }}</p>
              <Button
                type="button"
                variant="outline"
                :disabled="busy || draft.password.length < 12"
                @click="resetPassword"
                >{{ t("users.resetPassword") }}</Button
              >
            </div>
          </div>
          <div class="editor-footer">
            <Button
              type="button"
              variant="outline"
              :disabled="busy"
              @click="open = false"
              >{{ t("ui.cancel") }}</Button
            ><Button :loading="busy" type="submit">{{ t("ui.save") }}</Button>
          </div>
        </form>
      </SheetContent></Sheet
    >
  </section>
</template>
