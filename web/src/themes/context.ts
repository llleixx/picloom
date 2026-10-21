import { appearance, darkMode, setAppearance } from "../lib/appearance";
import { reactive, watch, type WatchStopHandle } from "vue";
import type {
  Config,
  Page,
  Snapshot,
  ThemeContext,
  ThemeView,
} from "../../../theme-sdk";
import type {
  ClientSettings,
  UploadDefaults,
  UploadProfileView,
} from "../../../shared/api";
import {
  siteText,
  supportedLocales,
  languages,
  isLocale,
} from "../../../shared/locales";
import {
  api,
  ApiError,
  clearPrivateQueries,
  clearSession,
  copy,
  errorText,
  errorValue,
  messageText,
  type DisplayMessage,
  getSession,
  notice,
  notify,
  session,
  setUnauthorizedHandler,
} from "../lib/api";
import {
  availableLocales,
  configureLanguages,
  locale,
  setLocale,
  t,
} from "../lib/i18n";
import {
  uploads,
  enqueue,
  enqueueUrls,
  cancelUpload,
  resumeUpload,
  dismissUpload,
} from "../lib/uploads";
import {
  copyFormats,
  copyPreferences,
  formatLink,
  type CopyFormat,
} from "../lib/link-formats";
import { safeReturn } from "../lib/safe-return";
export function createThemeRuntime(navigate: (path: string) => void) {
  const state = reactive({
    page: "home" as Page,
    settings: null as ClientSettings | null,
    profiles: [] as UploadProfileView[],
    selected: "",
    loading: true,
    error: "" as DisplayMessage,
    login: {
      busy: false,
      error: "" as DisplayMessage,
      expired: false,
      unavailable: false,
    },
  });
  const site = () => ({
    name: state.settings ? siteText(state.settings, locale.value, "name") : "",
    homeTitle: state.settings
      ? siteText(state.settings, locale.value, "name")
      : "",
    description: state.settings
      ? siteText(state.settings, locale.value, "description")
      : "",
    logoUrl: state.settings?.siteLogoUrl ?? "",
    faviconUrl: state.settings?.siteFaviconUrl ?? "",
  });
  watch(
    () => [locale.value, state.settings, state.page],
    () => {
      document.title = [
        state.page === "login" ? t("ui.signIn") : t("home.upload"),
        site().name,
      ]
        .filter(Boolean)
        .join(" · ");
      let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!icon) {
        icon = document.createElement("link");
        icon.rel = "icon";
        document.head.append(icon);
      }
      if (site().faviconUrl) icon.href = site().faviconUrl;
      else icon.remove();
      icon.onerror = () => icon?.remove();
    },
    { immediate: true },
  );
  const preferenceKey = () =>
    "uploadProfile:" + (session.value?.user.id ?? "guest");
  let refreshGeneration = 0;
  async function refresh() {
    const generation = ++refreshGeneration;
    state.loading = true;
    state.error = "";
    try {
      const settings = await api<ClientSettings>(
        "/api/client-settings",
        {},
        false,
      );
      if (generation !== refreshGeneration) return;
      state.settings = settings;
      syncLanguages();
      try {
        await getSession();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) clearSession();
        else throw e;
      }
      const [profiles, defaults] = await Promise.all([
        api<UploadProfileView[]>("/api/upload-profiles", {}, false),
        api<UploadDefaults>("/api/upload-defaults", {}, false),
      ]);
      if (generation !== refreshGeneration) return;
      state.profiles = profiles;
      const remembered = localStorage.getItem(preferenceKey());
      state.selected = profiles.some((p) => p.id === remembered && p.enabled)
        ? remembered!
        : defaults.defaultProfileId || "";
    } catch (e) {
      if (generation === refreshGeneration) {
        state.profiles = [];
        state.selected = "";
        state.error = errorValue(e);
      }
    } finally {
      if (generation === refreshGeneration) state.loading = false;
    }
  }
  let currentView: ThemeView | null = null;
  let previewView: ThemeView | null = null;
  function syncLanguages() {
    const settings = state.settings;
    const supported = currentView?.manifest.supportedLocales;
    const defaults =
      previewView?.draftLanguage?.defaultLocale ??
      settings?.defaultLocale ??
      "en-US";
    const allowed = supported
      ? (settings?.enabledLocales ?? supportedLocales).filter((lang) =>
          supported.includes(lang),
        )
      : state.page === "home"
        ? (settings?.enabledLocales ?? supportedLocales)
        : supportedLocales;
    if (supported && (!isLocale(defaults) || !allowed.includes(defaults)))
      throw new Error("Theme does not support the site default language");
    configureLanguages(
      allowed,
      isLocale(defaults) ? defaults : "en-US",
      previewView?.draftLanguage && isLocale(defaults) ? defaults : null,
    );
  }
  function setPage(page: Page) {
    state.page = page;
    state.login.error = "";
    const query = new URLSearchParams(location.search);
    state.login.expired = query.has("expired");
    state.login.unavailable = query.has("unavailable");
    syncLanguages();
  }
  setUnauthorizedHandler(() => {
    clearSession();
    state.profiles = [];
    state.selected = "";
    navigate(
      "/login?expired=1&return=" +
        encodeURIComponent(location.pathname + location.search),
    );
  });
  const pending = () =>
    uploads.some((u) =>
      ["queued", "uploading", "processing"].includes(u.status),
    );
  window.addEventListener("beforeunload", (e) => {
    if (pending()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  function snapshot(): Snapshot {
    return {
      page: state.page,
      site: site(),
      user: session.value ? { name: session.value.user.username } : null,
      locale: locale.value,
      locales: [...availableLocales.value],
      languages: languages
        .filter((lang) => availableLocales.value.includes(lang.tag))
        .map((lang) => ({
          tag: lang.tag,
          name: lang.name,
          direction: lang.direction,
        })),
      defaultLocale:
        previewView?.draftLanguage?.defaultLocale ??
        state.settings?.defaultLocale ??
        "en-US",
      mode: appearance.value,
      dark: darkMode.value,
      profiles: state.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        available: p.available,
        maxUploadBytes: p.maxUploadBytes,
        allowedMimeTypes: [...p.allowedMimeTypes],
        reason: p.reasonCode
          ? errorText(new ApiError(p.reasonCode, p.reason || ""))
          : p.reason,
      })),
      selectedProfileId: state.selected,
      uploads: uploads
        .filter((u) => !u.replaceId)
        .map((u) => ({
          id: u.id,
          name: u.file.name,
          size: u.file.size,
          profileName: u.profileName,
          sourceUrl: u.sourceUrl,
          status: u.status,
          progress: u.progress,
          resumable: u.resumable,
          error: u.error === undefined ? undefined : messageText(u.error),
          result: u.result ? { ...u.result } : undefined,
        })),
      loading: state.loading,
      error: messageText(state.error),
      login: { ...state.login, error: messageText(state.login.error) },
      copy: { ...copyPreferences, formats: [...copyFormats] },
      notice: notice.value,
    };
  }
  const profile = () => {
    const p = state.profiles.find(
      (p) => p.id === state.selected && p.available,
    );
    if (!p) notify({ key: "ui.selectAnAvailableUploadProfile" });
    return p;
  };
  function context(view: ThemeView | null, preview: ThemeView | null = null) {
    previewView = preview;
    currentView = view;
    syncLanguages();
    const stops = new Set<WatchStopHandle>();
    const config: Config = structuredClone(view?.config ?? {});
    const ctx: ThemeContext = {
      apiVersion: 1,
      config,
      getSnapshot: snapshot,
      subscribe(listener) {
        const stop = watch(snapshot, (s) => listener(s), { deep: true });
        stops.add(stop);
        listener(snapshot());
        return () => {
          stop();
          stops.delete(stop);
        };
      },
      asset(path) {
        if (
          !view ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((p) => p === "..") ||
          /^[a-z]+:/i.test(path)
        )
          throw new Error("Invalid theme resource path");
        return new URL(path, location.origin + view.baseUrl).href;
      },
      t(key, params = {}) {
        const dict = view?.manifest.messages;
        const current = dict?.[locale.value];
        const fallback = view ? dict?.[view.manifest.defaultLocale] : undefined;
        const value =
          (current && Object.hasOwn(current, key) ? current[key] : undefined) ??
          (fallback && Object.hasOwn(fallback, key)
            ? fallback[key]
            : undefined) ??
          key;
        return value.replace(/\{(\w+)\}/g, (match, k: string) =>
          String(params[k] ?? match),
        );
      },
      localized(value) {
        if (typeof value === "string") return value;
        if (!value || Array.isArray(value) || typeof value !== "object")
          return "";
        return typeof value[locale.value] === "string"
          ? (value[locale.value] as string)
          : "";
      },
      setLocale(language) {
        if (!isLocale(language) || !availableLocales.value.includes(language))
          throw new Error("Language is not available on this page");
        if (previewView?.draftLanguage)
          configureLanguages(availableLocales.value, language, language);
        else setLocale(language);
      },
      setMode: setAppearance,
      navigate(page) {
        navigate(
          page === "home"
            ? "/"
            : page === "login"
              ? "/login?return=/app/images"
              : "/app/images",
        );
      },
      selectProfile(id) {
        if (state.profiles.some((p) => p.id === id && p.available)) {
          state.selected = id;
          localStorage.setItem(preferenceKey(), id);
        }
      },
      refresh,
      uploads: {
        add(files) {
          const p = profile();
          if (p) enqueue(files, p);
        },
        addUrls(urls) {
          const p = profile();
          if (!p) return;
          try {
            if (
              !urls.every((u) =>
                ["http:", "https:"].includes(new URL(u).protocol),
              )
            )
              throw new Error();
            enqueueUrls(urls, p);
          } catch {
            notify({ key: "ui.invalidParametersOrProcessingLimitExceeded" });
          }
        },
        async cancel(id) {
          const u = uploads.find((u) => u.id === id && !u.replaceId);
          if (u) await cancelUpload(u);
        },
        resume(id) {
          const u = uploads.find((u) => u.id === id && !u.replaceId);
          if (u) resumeUpload(u);
        },
        async dismiss(id) {
          const u = uploads.find((u) => u.id === id && !u.replaceId);
          if (u) await dismissUpload(u);
        },
      },
      links: {
        format(url) {
          return formatLink(url, copyPreferences.format);
        },
        copy(url) {
          return copy(formatLink(url, copyPreferences.format));
        },
        copyAll() {
          return copy(
            uploads
              .filter((u) => !u.replaceId && u.result)
              .map((u) => formatLink(u.result!.url, copyPreferences.format))
              .join("\n"),
          );
        },
        setPreferences(format, auto) {
          if (copyFormats.includes(format as CopyFormat)) {
            copyPreferences.format = format as CopyFormat;
            copyPreferences.auto = auto;
          }
        },
      },
      async login(username, password) {
        if (state.login.busy) return;
        state.login.busy = true;
        state.login.error = "";
        try {
          await api(
            "/api/auth/login",
            { method: "POST", body: JSON.stringify({ username, password }) },
            false,
          );
          password = "";
          clearPrivateQueries();
          await getSession();
          const target = safeReturn(
            new URLSearchParams(location.search).get("return"),
          );
          if (target.split("?")[0] === "/") await refresh();
          navigate(target);
        } catch (e) {
          state.login.error =
            e instanceof ApiError && e.status === 401
              ? new ApiError("LOGIN_FAILED", "")
              : errorValue(e);
        } finally {
          state.login.busy = false;
        }
      },
    };
    return {
      ctx,
      dispose() {
        for (const stop of stops) stop();
        stops.clear();
      },
    };
  }
  return { refresh, setPage, context };
}
