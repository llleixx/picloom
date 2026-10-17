import { webPages } from "../../shared/web-routes";
import { isSiteAdmin } from "../../shared/roles";
import { createRouter, createWebHistory } from "vue-router";
import {
  ApiError,
  clearSession,
  getSession,
  session,
  setUnauthorizedHandler,
} from "./lib/api";
import Users from "./pages/Users.vue";
import Home from "./pages/Home.vue";
import Login from "./pages/Login.vue";
import Files from "./pages/Files.vue";
import Tokens from "./pages/Tokens.vue";
import Account from "./pages/Account.vue";
import StorageSources from "./pages/StorageSources.vue";
import StorageGroups from "./pages/StorageGroups.vue";
import UploadProfiles from "./pages/UploadProfiles.vue";
import Pipelines from "./pages/Pipelines.vue";
import System from "./pages/System.vue";
import Settings from "./pages/Settings.vue";
import Plugins from "./pages/Plugins.vue";
import { navigation } from "./lib/navigation";
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/app", redirect: "/app/images" },
    { path: "/login", component: Login },
    { path: "/app/images", component: Files },
    { path: "/app/tokens", component: Tokens },
    { path: "/app/account", component: Account },
    { path: "/app/users", component: Users },
    { path: "/app/system", component: System },
    { path: "/app/settings", component: Settings },
    { path: "/app/plugins", component: Plugins },
    { path: "/app/config/pipelines", component: Pipelines },
    { path: "/app/config/sources", component: StorageSources },
    { path: "/app/config/groups", component: StorageGroups },
    { path: "/app/config/profiles", component: UploadProfiles },
  ].map((route) => ({
    ...route,
    meta: navigation.find((page) => page.path === route.path) ?? {},
  })),
});
export function safeReturn(value: unknown) {
  return typeof value === "string" &&
    webPages.includes(value.split("?")[0]!) &&
    value.split("?")[0] !== "/login"
    ? value
    : "/app/images";
}
router.beforeEach(async (to) => {
  if (to.path === "/login") return;
  if (!session.value) {
    try {
      await getSession();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (to.path === "/") return;
        clearSession();
      }
      return {
        path: "/login",
        query: {
          return: to.fullPath,
          ...(e instanceof ApiError && e.status === 401
            ? {}
            : { unavailable: "1" }),
        },
      };
    }
  }
  if (to.meta.ownerOnly && session.value?.user.role !== "owner")
    return "/app/images";
  if (to.meta.adminOnly && !isSiteAdmin(session.value?.user.role))
    return "/app/images";
});
setUnauthorizedHandler(() => {
  const back = router.currentRoute.value.fullPath;
  clearSession();
  if (router.currentRoute.value.path !== "/login")
    void router.replace({
      path: "/login",
      query: { return: back, expired: "1" },
    });
});
