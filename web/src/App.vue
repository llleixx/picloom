<script setup lang="ts">
import { darkMode, setAppearance } from "./lib/appearance";
import { supportedLocales } from "../../shared/locales";
import { navigation, navigationGroups } from "./lib/navigation";
import { t, configureLanguages } from "@/lib/i18n";
import { ref, watch, watchEffect, computed } from "vue";
import { useRoute } from "vue-router";
import { CloudUpload, Moon, Sun, Menu } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { notice, session, isAdmin } from "./lib/api";
import SiteBrand from "@/components/SiteBrand.vue";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useSite } from "@/lib/site";
const { name: siteName, faviconUrl, settings, pending } = useSite();
watch(
  faviconUrl,
  (url) => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.append(link);
    }
    link.onerror = () => link?.remove();
    if (url) link.href = url;
    else link.remove();
  },
  { immediate: true },
);
const route = useRoute();
watchEffect(() => {
  configureLanguages(
    route.path === "/"
      ? (settings.value?.enabledLocales ?? supportedLocales)
      : supportedLocales,
    settings.value?.defaultLocale ?? "en-US",
  );
});
const menu = ref(false);
const dark = computed({
  get: () => darkMode.value,
  set: (value) => setAppearance(value ? "dark" : "light"),
});
watch(
  () => route.path,
  () => (menu.value = false),
);
const groups = computed(() =>
  navigationGroups
    .map((group) => ({
      ...group,
      links: navigation.filter(
        (page) =>
          page.group === group.id &&
          (!page.adminOnly || isAdmin.value) &&
          (!page.ownerOnly || session.value?.user.role === "owner"),
      ),
    }))
    .filter((group) => group.links.length),
);
const currentPage = computed(() =>
  navigation.find((page) => page.path === route.path),
);
const currentGroup = computed(() =>
  navigationGroups.find((group) => group.id === currentPage.value?.group),
);
watchEffect(() => {
  const title =
    route.path === "/login"
      ? t("ui.signIn")
      : currentPage.value
        ? t(currentPage.value.title)
        : "";
  document.title = title ? title + " · " + siteName.value : siteName.value;
});
</script>
<template>
  <div v-if="pending" class="min-h-screen" aria-busy="true"></div>
  <div v-else class="min-h-screen md:pl-56">
    <aside
      class="fixed inset-y-0 left-0 hidden w-56 flex-col overflow-y-auto border-r bg-background p-5 md:flex"
    >
      <a
        href="/"
        class="mb-7 mt-3 flex items-center gap-3 text-lg font-semibold tracking-tight"
        ><SiteBrand
      /></a>
      <a
        href="/"
        class="mb-5 flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        ><CloudUpload :size="18" />{{ t("home.upload") }}</a
      >
      <nav :aria-label="t('ui.mainNavigation')" class="space-y-6 pb-6">
        <section
          v-for="group in groups"
          :key="group.id"
          :aria-label="t(group.label)"
        >
          <h2
            class="mb-2 px-3 text-[10px] font-semibold tracking-[.2em] text-muted-foreground"
          >
            {{ t(group.label) }}
          </h2>
          <RouterLink
            v-for="link in group.links"
            :key="link.path"
            :to="link.path"
            class="flex items-center gap-3 border-l-2 border-transparent rounded-r-md px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40"
            active-class="!border-primary !bg-primary/5 !text-primary font-medium"
          >
            <component :is="link.icon" :size="18" />{{ t(link.title) }}
          </RouterLink>
        </section>
      </nav>
      <div class="mt-auto border-t pt-5">
        <RouterLink
          to="/app/account"
          :aria-label="t('ui.account')"
          class="flex items-center gap-3 rounded-md hover:text-primary"
        >
          <span
            class="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-semibold"
            >{{ session?.user.username.slice(0, 1).toUpperCase() }}</span
          >
          <div>
            <p class="text-sm font-medium">{{ session?.user.username }}</p>
            <p class="text-xs text-muted-foreground">
              {{
                session?.user.role === "owner"
                  ? t("users.owner")
                  : isAdmin
                    ? t("ui.administrator")
                    : t("users.member")
              }}
            </p>
          </div>
        </RouterLink>
      </div>
    </aside>
    <header
      class="flex h-17 items-center justify-between border-b bg-background px-5 md:px-9"
    >
      <div class="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          class="md:hidden"
          :aria-label="t('ui.openNavigation')"
          @click="menu = true"
          ><Menu :size="19" /></Button
        ><span class="text-xs text-muted-foreground"
          ><template v-if="currentGroup"
            >{{ t(currentGroup.label)
            }}<span class="mx-3 text-border">/</span></template
          >
          {{ currentPage ? t(currentPage.title) : "" }}</span
        >
      </div>
      <div class="flex items-center gap-3">
        <LanguageSwitcher />
        <Button
          variant="ghost"
          size="icon"
          :aria-label="dark ? t('ui.lightMode') : t('ui.darkMode')"
          @click="dark = !dark"
          ><Sun v-if="dark" :size="18" /><Moon v-else :size="18"
        /></Button>
      </div>
    </header>
    <main class="mx-auto max-w-[1600px] p-5 md:p-9"><RouterView /></main>
    <Sheet v-model:open="menu"
      ><SheetContent side="left" class="w-64 overflow-y-auto p-6"
        ><SheetTitle><SiteBrand /></SheetTitle
        ><SheetDescription>{{ t("ui.navigation") }}</SheetDescription>
        <nav class="mt-5 space-y-5">
          <a @click="menu = false" href="/" class="block px-3 py-2">{{
            t("home.upload")
          }}</a>
          <section
            v-for="group in groups"
            :key="group.id"
            :aria-label="t(group.label)"
          >
            <h2 class="px-3 text-xs text-muted-foreground">
              {{ t(group.label) }}
            </h2>
            <RouterLink
              @click="menu = false"
              v-for="link in group.links"
              :key="link.path"
              :to="link.path"
              class="block rounded-lg px-3 py-2 hover:bg-muted"
              active-class="bg-muted text-primary"
              >{{ t(link.title) }}</RouterLink
            >
          </section>
          <RouterLink
            @click="menu = false"
            to="/app/account"
            class="block border-t px-3 py-3"
            >{{ t("ui.account") }}</RouterLink
          >
        </nav></SheetContent
      ></Sheet
    >
  </div>
  <div
    v-if="notice"
    role="status"
    class="fixed bottom-6 left-1/2 z-[100] max-w-[90vw] -translate-x-1/2 rounded-xl border bg-card px-5 py-3 text-sm shadow-lg"
  >
    {{ notice }}
  </div>
</template>
