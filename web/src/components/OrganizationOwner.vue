<script setup lang="ts">
import { computed, ref } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api, isAdmin } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Input } from "./ui/input";
import type { UserView } from "../../../shared/api";
const model = defineModel<string>({ required: true });
const search = ref("");
const users = useQuery({
  queryKey: computed(() => ["users", "organization", search.value]),
  enabled: isAdmin,
  queryFn: () =>
    api<{ items: UserView[] }>(
      "/api/users?limit=100&q=" + encodeURIComponent(search.value),
    ),
});
</script>
<template>
  <div v-if="isAdmin" class="flex flex-wrap gap-2">
    <select
      v-model="model"
      class="native-select"
      :aria-label="t('users.owner')"
    >
      <option value="me">{{ t("users.myImages") }}</option>
      <option
        v-if="
          model !== 'me' && !users.data.value?.items.some((u) => u.id === model)
        "
        :value="model"
      >
        {{ model }}
      </option>
      <option
        v-for="user in users.data.value?.items"
        :key="user.id"
        :value="user.id"
      >
        {{ user.username }}
      </option></select
    ><Input
      v-model="search"
      class="max-w-56"
      :placeholder="t('users.search')"
      :aria-label="t('users.search')"
    />
  </div>
</template>
