import { manifest, config, production } from "virtual:picloom-preview";
import { createPreview, scenarios, type Scenario } from "./context";
import type { Page, ThemeModule } from "@picloom/theme-sdk";
const root = document.getElementById("app")!;
let instance: { dispose(): void } | undefined,
  generation = 0;
const sourceModule = production ? "/entry.js" : "/src/entry.ts";
const runtime = createPreview(manifest, config, navigate);
const preview = document.createElement("aside");
preview.id = "picloom-preview-tools";
const shadow = preview.attachShadow({ mode: "open" });
shadow.innerHTML = `<style>:host{position:fixed;right:12px;bottom:12px;z-index:2147483647;font:13px system-ui;color:#eee}details{background:#15212e;border:1px solid #617080;border-radius:10px;padding:12px;max-width:300px;box-shadow:0 4px 20px #0005}summary{cursor:pointer;font-weight:bold}label{display:grid;gap:4px;margin-top:10px}select{background:#fff;color:#17212c;padding:5px;min-width:220px}p{max-width:260px;font-size:12px}output{display:block;color:#ffd37c;white-space:pre-wrap;overflow-wrap:anywhere}</style>
<details open><summary>Picloom · Preview / 预览</summary><p>${production ? "Production build / 构建产物" : "Source HMR / 源码热更新"}<br>SIMULATED uploads and login<br>模拟上传与登录，不连接真实服务</p>
<label>Page / 页面<select id="page"><option value="home">Home / 首页</option><option value="login">Login / 登录</option></select></label>
<label>Language / 语言<select id="language"></select></label>
<label>Appearance / 外观<select id="mode"><option value="auto">System / 跟随系统</option><option value="light">Light / 浅色</option><option value="dark">Dark / 深色</option></select></label>
<label>Identity / 身份<select id="identity"><option value="guest">Guest / 访客</option><option value="user">Signed in / 已登录</option></select></label>
<label>Scenario / 场景<select id="scenario"></select></label><output role="alert"></output></details>`;
document.body.append(preview);
const select = (id: string) => shadow.getElementById(id) as HTMLSelectElement;
const errors = shadow.querySelector("output")!;
function option(value: string, label: string) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}
for (const language of runtime.ctx.getSnapshot().languages)
  select("language").append(option(language.tag, language.name));
const labels: Record<Scenario, string> = {
  ready: "Ready / 就绪",
  loading: "Loading / 加载中",
  uploading: "Uploading / 上传中",
  success: "Success / 上传成功",
  failed: "Failed / 上传失败",
  "no-profiles": "No profiles / 无可用方案",
  "login-error": "Login error / 登录失败",
};
for (const scenario of scenarios)
  select("scenario").append(option(scenario, labels[scenario]));
select("page").onchange = () => navigate(select("page").value as Page);
select("language").onchange = () =>
  runtime.ctx.setLocale(select("language").value);
select("mode").onchange = () =>
  runtime.ctx.setMode(select("mode").value as "auto" | "light" | "dark");
select("identity").onchange = () =>
  runtime.setUser(select("identity").value === "user");
select("scenario").onchange = () =>
  runtime.setScenario(select("scenario").value as Scenario);
const stop = runtime.ctx.subscribe((state) => {
  select("page").value = state.page;
  select("language").value = state.locale;
  select("mode").value = state.mode;
  select("identity").value = state.user ? "user" : "guest";
});
function cleanup() {
  const previous = instance;
  instance = undefined;
  try {
    previous?.dispose();
  } catch (error) {
    errors.textContent = String(error);
  } finally {
    root.replaceChildren();
  }
}
async function mount() {
  const current = ++generation;
  errors.textContent = "";
  cleanup();
  const subscriptions = new Set<() => void>();
  const links: HTMLLinkElement[] = [];
  const container = document.createElement("div");
  root.append(container);
  let mounted: Awaited<ReturnType<ThemeModule["mount"]>> | undefined;
  let cleaned = false;
  const context = {
    ...runtime.ctx,
    subscribe(listener: Parameters<typeof runtime.ctx.subscribe>[0]) {
      // An async mount may continue after its page has already been unmounted.
      if (cleaned) return () => {};
      const stop = runtime.ctx.subscribe(listener);
      subscriptions.add(stop);
      return () => {
        stop();
        subscriptions.delete(stop);
      };
    },
  };
  const dispose = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (typeof mounted?.dispose === "function") mounted.dispose();
    } finally {
      for (const stop of subscriptions) stop();
      subscriptions.clear();
      for (const link of links) link.remove();
      container.remove();
    }
  };
  instance = { dispose };
  try {
    const page = runtime.ctx.getSnapshot().page;
    const declaration = manifest.pages[page];
    if (!declaration)
      throw Error(
        `Theme does not declare ${page}; the real host will use its default page`,
      );
    const styles = new Set([
      ...(manifest.styles ?? []),
      ...(declaration.styles ?? []),
    ]);
    await Promise.all(
      [...styles]
        .filter((path) => production || path !== "style.css")
        .map(
          (path) =>
            new Promise<void>((resolve, reject) => {
              // The source entry imports src/style.css; other declared styles are public assets.
              const link = document.createElement("link");
              link.rel = "stylesheet";
              link.href = runtime.ctx.asset(path);
              link.onload = () => resolve();
              link.onerror = () =>
                reject(Error(`Missing theme style: ${path}`));
              links.push(link);
              document.head.append(link);
            }),
        ),
    );
    if (current !== generation || cleaned) return;
    const module: ThemeModule = await import(/* @vite-ignore */ sourceModule);
    if (typeof module.mount !== "function")
      throw Error("Theme must export mount(container, context)");
    if (current !== generation || cleaned) return;
    mounted = await module.mount(container, context);
    if (!mounted || typeof mounted.dispose !== "function")
      throw Error("mount() must return { dispose() }");
    if (current !== generation || cleaned) {
      if (cleaned) mounted.dispose();
      else dispose();
    }
  } catch (error) {
    try {
      dispose();
    } finally {
      if (current === generation) errors.textContent = String(error);
    }
  }
}
function navigate(page: Page) {
  history.pushState(null, "", page === "login" ? "/login" : "/");
  runtime.setPage(page);
  void mount();
}
function popstate() {
  runtime.setPage(location.pathname === "/login" ? "login" : "home");
  void mount();
}
window.addEventListener("popstate", popstate);
function dispose() {
  generation++;
  cleanup();
  stop();
  runtime.dispose();
  preview.remove();
  window.removeEventListener("popstate", popstate);
}
function pagehide(event: PageTransitionEvent) {
  if (!event.persisted) dispose();
}
window.addEventListener("pagehide", pagehide);
import.meta.hot?.dispose(() => {
  window.removeEventListener("pagehide", pagehide);
  dispose();
});
// Vue SFC/CSS updates use normal HMR. Entry changes invalidate the importer and reload.
await mount();
