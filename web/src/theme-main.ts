import { createThemeRuntime } from "./themes/context";
import type { Page, ThemeModule, ThemeView } from "../../theme-sdk";
import { api, ApiError, errorText } from "./lib/api";
import { t } from "./lib/i18n";
import defaultStyles from "./style.css?url";
const root = document.getElementById("app")!;
let generation = 0;
let dispose: (() => void) | undefined;
const initialQuery = new URLSearchParams(location.search);
let forceDefault = initialQuery.get("theme") === "default";
const previewId = initialQuery.get("previewId"),
  previewVersion = initialQuery.get("previewVersion");
function navigate(path: string) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) return;
  if (!["/", "/login"].includes(url.pathname)) {
    location.assign(url.href);
    return;
  }
  if (forceDefault) url.searchParams.set("theme", "default");
  if (previewId && previewVersion) {
    url.searchParams.set("previewId", previewId);
    url.searchParams.set("previewVersion", previewVersion);
  }
  history.pushState(null, "", url);
  void render();
}
const runtime = createThemeRuntime(navigate);
window.addEventListener("popstate", () => {
  void render();
});
function banner(text: string) {
  const bar = document.createElement("div");
  bar.role = "status";
  bar.style.cssText =
    "padding:12px;background:#fff3cd;color:#332701;font:14px system-ui;border-bottom:1px solid #d5bf7c";
  bar.textContent = text;
  root.prepend(bar);
}
async function render() {
  const current = ++generation;
  dispose?.();
  dispose = undefined;
  root.replaceChildren();
  const page: Page = location.pathname === "/login" ? "login" : "home";
  runtime.setPage(page);
  forceDefault ||=
    new URLSearchParams(location.search).get("theme") === "default";
  let view: ThemeView | null = null;
  let warning = "";
  if (!forceDefault) {
    try {
      view = await api<ThemeView | null>(
        previewId && previewVersion
          ? `/api/themes/${encodeURIComponent(previewId)}/${encodeURIComponent(previewVersion)}/preview`
          : "/api/theme",
        {},
        false,
      );
    } catch (e) {
      warning =
        errorText(e) +
        (e instanceof ApiError && e.fields.length
          ? " · " + e.fields.map((field) => field.path).join(", ")
          : "");
    }
  }
  if (current !== generation) return;
  if (previewId && previewVersion && warning) {
    root.textContent = warning;
    root.setAttribute("role", "alert");
    return;
  }
  root.removeAttribute("role");
  if (previewId && previewVersion) banner(t("themes.previewWarning"));
  async function mount(selected: ThemeView | null) {
    const entry = selected?.manifest.pages[page];
    if (selected && selected.manifest.apiVersion !== 1)
      throw new Error(t("themes.incompatible"));
    const styles = entry
      ? [...(selected!.manifest.styles ?? []), ...(entry.styles ?? [])].map(
          (p) => selected!.baseUrl + p,
        )
      : [defaultStyles];
    const links: HTMLLinkElement[] = [];
    const container = document.createElement("div");
    root.append(container);
    const scope = runtime.context(
      entry ? selected : null,
      previewId && previewVersion ? view : null,
    );
    let instance: { dispose(): void } | undefined,
      cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        instance?.dispose();
      } catch {
        /* A broken theme must not block recovery. */
      }
      scope.dispose();
      for (const link of links) link.remove();
      container.remove();
    };
    dispose = cleanup;
    try {
      await Promise.all(
        styles.map(
          (href) =>
            new Promise<void>((resolve, reject) => {
              const link = document.createElement("link");
              links.push(link);
              link.rel = "stylesheet";
              link.href = href;
              const timeout = setTimeout(
                () => reject(new Error(t("themes.loadFailed"))),
                15000,
              );
              link.onload = () => {
                clearTimeout(timeout);
                resolve();
              };
              link.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(t("themes.loadFailed")));
              };
              document.head.append(link);
            }),
        ),
      );
      if (current !== generation) {
        cleanup();
        return;
      }
      const module: ThemeModule = entry
        ? await import(/* @vite-ignore */ selected!.baseUrl + entry.entry)
        : await import("./themes/default");
      if (current !== generation) {
        cleanup();
        return;
      }
      instance = await module.mount(container, scope.ctx);
      if (!instance || typeof instance.dispose !== "function")
        throw new Error(t("themes.loadFailed"));
      if (current !== generation || cleaned) {
        try {
          instance.dispose();
        } finally {
          cleanup();
        }
      }
    } catch (e) {
      cleanup();
      throw e;
    }
  }
  try {
    await mount(view);
  } catch {
    if (current !== generation) return;
    warning = t("themes.loadFailed");
    try {
      await mount(null);
    } catch {
      root.textContent = t("themes.loadFailed");
    }
  }
  if (current === generation && warning)
    banner(t("themes.fallback") + " " + warning);
}
void runtime.refresh().then(() => render());
