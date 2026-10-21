import type {
  Config,
  Manifest,
  Page,
  Snapshot,
  ThemeContext,
  Upload,
} from "@picloom/theme-sdk";
import { languages, messageText } from "./helpers.js";
export const scenarios = [
  "ready",
  "loading",
  "uploading",
  "success",
  "failed",
  "no-profiles",
  "login-error",
] as const;
export type Scenario = (typeof scenarios)[number];
const copy = <T>(value: T): T => structuredClone(value);
export function createPreview(
  manifest: Manifest,
  config: Config,
  navigate: (page: Page) => void,
) {
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const motion = matchMedia("(prefers-color-scheme: dark)");
  const state: Snapshot = {
    page: location.pathname === "/login" ? "login" : "home",
    site: {
      name: "Preview gallery",
      homeTitle: "Preview gallery",
      description: "SIMULATED uploads and login · 模拟上传与登录",
      logoUrl: "",
      faviconUrl: "",
    },
    user: null,
    locale: manifest.defaultLocale,
    locales: manifest.supportedLocales,
    languages: languages.filter((language) =>
      manifest.supportedLocales.includes(language.tag),
    ),
    defaultLocale: manifest.defaultLocale,
    mode: "auto",
    dark: motion.matches,
    profiles: [
      {
        id: "mock",
        name: "Simulated / 模拟上传",
        enabled: true,
        available: true,
        maxUploadBytes: 50 * 1024 ** 2,
        allowedMimeTypes: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/svg+xml",
        ],
        reason: null,
      },
    ],
    selectedProfileId: "mock",
    uploads: [],
    loading: false,
    error: "",
    login: { busy: false, error: "", expired: false, unavailable: false },
    copy: {
      format: "URL",
      auto: false,
      formats: ["URL", "Markdown", "HTML", "BBCode"],
    },
    notice: "",
  };
  let scenario: Scenario = "ready",
    alive = true;
  const text = (en: string, zh: string) => (state.locale === "zh-CN" ? zh : en);
  function emit() {
    if (alive) for (const listener of listeners) listener(copy(state));
  }
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (alive) callback();
    }, delay);
    timers.add(timer);
  }
  function clear() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  function notify(en: string, zh: string) {
    state.notice = text(en, zh);
    emit();
  }
  function result(id: string) {
    return { id, url: `https://example.invalid/simulated/${id}.png` };
  }
  function format(url: string) {
    switch (state.copy.format) {
      case "Markdown":
        return `![](${url})`;
      case "HTML":
        return `<img src="${url}" alt="">`;
      case "BBCode":
        return `[img]${url}[/img]`;
      default:
        return url;
    }
  }
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("Copied", "已复制");
    } catch {
      notify("Clipboard unavailable", "剪贴板不可用");
    }
  }
  function run(item: Upload) {
    later(() => {
      if (
        !state.uploads.includes(item) ||
        !["queued", "uploading"].includes(item.status)
      )
        return;
      item.status = "uploading";
      item.progress = Math.min(100, item.progress + 25);
      if (item.progress === 100) {
        item.status = "success";
        item.result = result(item.id);
        if (state.copy.auto) void copyText(format(item.result.url));
      } else run(item);
      emit();
    }, 400);
  }
  function add(name: string, size: number, sourceUrl?: string) {
    if (
      !state.profiles.some(
        (profile) =>
          profile.id === state.selectedProfileId && profile.available,
      )
    ) {
      notify(
        "Choose an available simulated profile",
        "请选择可用的模拟上传方案",
      );
      return;
    }
    const item: Upload = {
      id: crypto.randomUUID(),
      name,
      size,
      profileName: state.profiles[0]!.name,
      sourceUrl,
      status: "queued",
      progress: 0,
    };
    state.uploads = [...state.uploads, item];
    run(item);
    emit();
  }
  function setScenario(value: Scenario) {
    clear();
    scenario = value;
    state.uploads = [];
    state.loading = value === "loading";
    state.login.busy = false;
    state.login.error =
      value === "login-error"
        ? text("Simulated login failure", "模拟登录失败")
        : "";
    state.notice = "";
    state.profiles = state.profiles.map((profile) => ({
      ...profile,
      available: value !== "no-profiles",
    }));
    state.selectedProfileId = value === "no-profiles" ? "" : "mock";
    if (["uploading", "success", "failed"].includes(value)) {
      const item: Upload = {
        id: "preview-image",
        name: "simulated-image.png",
        size: 128 * 1024,
        profileName: state.profiles[0]!.name,
        status: value as Upload["status"],
        progress: value === "uploading" ? 50 : value === "success" ? 100 : 0,
      };
      if (value === "success") item.result = result(item.id);
      if (value === "failed") {
        item.error = text("Simulated upload failure", "模拟上传失败");
        item.resumable = true;
      }
      state.uploads = [item];
    }
    emit();
  }
  function appearance() {
    state.dark = state.mode === "auto" ? motion.matches : state.mode === "dark";
    document.documentElement.classList.toggle("dark", state.dark);
    emit();
  }
  motion.addEventListener("change", appearance);
  const ctx: ThemeContext = {
    apiVersion: 1,
    config: copy(config),
    getSnapshot: () => copy(state),
    subscribe(listener) {
      listeners.add(listener);
      listener(copy(state));
      return () => {
        listeners.delete(listener);
      };
    },
    asset(path) {
      if (
        !path ||
        path.startsWith("/") ||
        /[\\:?*<>"|]/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw Error("Invalid package asset path");
      return new URL("/" + path, location.origin).href;
    },
    t(key, params = {}) {
      return messageText(manifest, state.locale, key).replace(
        /\{(\w+)\}/g,
        (match, name: string) => String(params[name] ?? match),
      );
    },
    localized(value) {
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return "";
      return typeof value[state.locale] === "string"
        ? (value[state.locale] as string)
        : "";
    },
    setLocale(language) {
      if (!state.locales.includes(language))
        throw Error("Language is not supported");
      state.locale = language;
      document.documentElement.lang = language;
      if (state.login.error)
        state.login.error = text("Simulated login failure", "模拟登录失败");
      for (const item of state.uploads)
        if (item.error)
          item.error = text("Simulated upload failure", "模拟上传失败");
      emit();
    },
    setMode(mode) {
      state.mode = mode;
      appearance();
    },
    navigate(page) {
      if (page === "app")
        notify(
          "Workspace is unavailable in simulated preview",
          "模拟预览不提供管理后台",
        );
      else navigate(page);
    },
    selectProfile(id) {
      state.selectedProfileId = id;
      emit();
    },
    async refresh() {
      state.error = "";
      setScenario("ready");
    },
    uploads: {
      add(files) {
        for (const file of files) add(file.name, file.size);
      },
      addUrls(urls) {
        for (const sourceUrl of urls) {
          try {
            const url = new URL(sourceUrl);
            if (!["http:", "https:"].includes(url.protocol)) throw Error();
            add(
              url.pathname.split("/").pop() || "remote-image",
              1024,
              sourceUrl,
            );
          } catch {
            notify("Invalid image URL", "图片地址无效");
          }
        }
      },
      async cancel(id) {
        const item = state.uploads.find((item) => item.id === id);
        if (item && ["queued", "uploading"].includes(item.status))
          item.status = "cancelled";
        emit();
      },
      resume(id) {
        const item = state.uploads.find((item) => item.id === id);
        if (item?.resumable) {
          item.status = "queued";
          item.error = undefined;
          run(item);
          emit();
        }
      },
      async dismiss(id) {
        state.uploads = state.uploads.filter((item) => item.id !== id);
        emit();
      },
    },
    links: {
      format,
      async copy(url) {
        await copyText(format(url));
      },
      async copyAll() {
        await copyText(
          state.uploads
            .flatMap((item) => (item.result ? [format(item.result.url)] : []))
            .join("\n"),
        );
      },
      setPreferences(format, auto) {
        if (!state.copy.formats.includes(format))
          throw Error("Unknown copy format");
        state.copy = { ...state.copy, format, auto };
        emit();
      },
    },
    async login(username, _password) {
      state.login.busy = true;
      state.login.error = "";
      emit();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (!alive) return;
      state.login.busy = false;
      if (scenario === "login-error")
        state.login.error = text("Simulated login failure", "模拟登录失败");
      else {
        state.user = { name: username || "Preview user" };
        navigate("home");
      }
      emit();
    },
  };
  appearance();
  document.documentElement.lang = state.locale;
  return {
    ctx,
    setScenario,
    setPage(page: Page) {
      state.page = page;
      emit();
    },
    setUser(signedIn: boolean) {
      state.user = signedIn ? { name: "Preview user" } : null;
      emit();
    },
    dispose() {
      alive = false;
      clear();
      listeners.clear();
      motion.removeEventListener("change", appearance);
    },
  };
}
