import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveFiles } from "../src/infra/archive";
import { handler } from "../src/http/app";
import { fixture } from "./helpers";
const repository = resolve(
  process.env.PICLOOM_TOOLING_DIR ??
    resolve(import.meta.dir, "../../picloom-tooling"),
);
const toolingTest =
  process.env.PICLOOM_TEST_THEME_TOOLING === "1" ? test : test.skip;
toolingTest(
  "packed theme tools create independent projects, preview with HMR and install real uploads/login",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "picloom-theme-tooling-"));
    const f = await fixture();
    const browser = await chromium.launch({ headless: true });
    let dev: ReturnType<typeof Bun.spawn> | undefined;
    let production: ReturnType<typeof Bun.spawn> | undefined;
    let host: ReturnType<typeof Bun.serve> | undefined;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink(process.execPath, join(bin, "bun"));
      await symlink(process.execPath, join(bin, "bunx"));
      expect(Bun.which("node", { PATH: bin })).toBeNull();
      expect(Bun.which("npm", { PATH: bin })).toBeNull();
      expect(Bun.which("zip", { PATH: bin })).toBeNull();
      async function run(cmd: string[], cwd: string, success = true) {
        const child = Bun.spawn(cmd, {
          cwd,
          env: { ...process.env, PATH: bin, NODE_PATH: "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (success && code !== 0)
          throw Error(`${cmd.join(" ")} (${code})\n${out}\n${err}`);
        return { code, out, err };
      }
      await run(["bun", "run", "build:create-theme"], repository);
      async function pack(directory: string, name: string) {
        const file = join(root, name + ".tgz");
        await run(
          [
            "bun",
            "pm",
            "pack",
            "--ignore-scripts",
            "--filename",
            file,
            "--quiet",
          ],
          join(repository, directory),
        );
        return file;
      }
      await run(["bun", "run", "build:theme-tools"], repository);
      const sdk = await pack("theme-sdk", "sdk");
      const themeTools = await pack("tools/theme-tools", "tools");
      const creator = await pack("tools/create-theme", "creator");
      const launcher = join(root, "launcher");
      await mkdir(launcher);
      await writeFile(join(launcher, "package.json"), '{"private":true}');
      await run(["bun", "add", "--ignore-scripts", creator], launcher);
      const project = join(root, "my-theme");
      await run(["bun", "create", "@picloom/theme", project], launcher);
      const manifestPath = join(project, "theme.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.id).toBe("example.my-theme");
      expect(
        (
          await run(
            ["bun", "create", "@picloom/theme", project],
            launcher,
            false,
          )
        ).code,
      ).not.toBe(0);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(
        manifest,
      );
      const dotted = join(root, "My name.");
      await run(["bun", "create", "@picloom/theme", dotted], launcher);
      expect(
        JSON.parse(await readFile(join(dotted, "theme.json"), "utf8")).id,
      ).toBe("example.my-name");
      const pkgPath = join(project, "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      pkg.devDependencies["@picloom/theme-sdk"] = "file:" + sdk;
      pkg.devDependencies["@picloom/theme-tools"] = "file:" + themeTools;
      expect(await Bun.file(join(project, "scripts/build.ts")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(project, "dev/context.ts")).exists()).toBe(
        false,
      );
      await writeFile(pkgPath, JSON.stringify(pkg));
      await run(["bun", "install"], project);
      const installedSdk = await Bun.file(
        join(project, "node_modules/@picloom/theme-sdk/package.json"),
      ).json();
      expect(installedSdk.bin).toBeUndefined();
      expect(installedSdk.exports["./dev"]).toBeUndefined();
      expect(installedSdk.files).toEqual(["index.ts", "README.md", "LICENSE"]);
      // Configuration defaults are written once, including localized and list defaults.
      manifest.configSchema = {
        type: "object",
        properties: {
          heading: {
            type: "string",
            "x-localized": true,
            default: { "en-US": "Seed", "zh-CN": "初始" },
          },
          rows: { type: "array", items: { type: "string" }, default: ["seed"] },
        },
      };
      const assets = join(project, "public/assets");
      await mkdir(assets);
      await writeFile(
        join(assets, "home.css"),
        "body { --preview-scene: home; }",
      );
      await writeFile(
        join(assets, "登录.css"),
        "body { --preview-scene: login; }",
      );
      manifest.pages.home.styles = ["assets/home.css"];
      manifest.pages.login.styles = ["assets/登录.css"];
      await writeFile(manifestPath, JSON.stringify(manifest));
      async function start(preview: boolean) {
        const temporary = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = temporary.port!;
        await temporary.stop(true);
        const child = Bun.spawn(
          ["bun", "run", preview ? "preview" : "dev", "--port", String(port)],
          {
            cwd: project,
            env: { ...process.env, PATH: bin, NODE_PATH: "" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const logs = Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        const url = `http://127.0.0.1:${port}`;
        for (let attempt = 0; attempt < 200; attempt++) {
          if (child.exitCode !== null) throw Error((await logs).join("\n"));
          try {
            if ((await fetch(url)).ok) return { child, url };
          } catch {}
          await Bun.sleep(50);
        }
        child.kill();
        throw Error("Preview startup timeout");
      }
      expect(
        (await run(["bun", "run", "preview"], project, false)).code,
      ).not.toBe(0);
      const source = await start(false);
      dev = source.child;
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      expect(await (await fetch(source.url)).text()).toContain("/@vite/client");
      await page.goto(source.url);
      await browserExpect(page.getByTestId("upload-input")).toHaveCount(1);
      await browserExpect(page.locator("body")).toHaveCSS(
        "--preview-scene",
        "home",
      );
      expect(
        JSON.parse(await readFile(join(project, "dev/config.json"), "utf8")),
      ).toEqual({
        heading: { "en-US": "Seed", "zh-CN": "初始" },
        rows: ["seed"],
      });
      await writeFile(
        join(project, "dev/config.json"),
        JSON.stringify({ heading: { "en-US": "" }, rows: [] }),
      );
      await browserExpect(page.getByTestId("upload-input")).toHaveCount(1);
      await writeFile(join(project, "dev/config.json"), '{"broken":');
      await page.reload();
      await browserExpect(page.locator("vite-error-overlay")).toHaveCount(1);
      expect(await readFile(join(project, "dev/config.json"), "utf8")).toBe(
        '{"broken":',
      );
      await writeFile(
        join(project, "dev/config.json"),
        JSON.stringify({ heading: { "en-US": "" }, rows: [] }),
      );
      await browserExpect(page.locator("vite-error-overlay")).toHaveCount(0);
      // A probe verifies mounted config and lifecycle cleanup without changing the template contract.
      const entryPath = join(project, "src/entry.ts");
      const entry = await readFile(entryPath, "utf8");
      await writeFile(
        entryPath,
        entry.replace(
          "const app = createApp",
          "document.body.dataset.config = JSON.stringify(context.config);\nconst app = createApp",
        ),
      );
      await browserExpect(page.locator("body")).toHaveAttribute(
        "data-config",
        JSON.stringify({ heading: { "en-US": "" }, rows: [] }),
      );
      await page
        .locator("#picloom-preview-tools #scenario")
        .selectOption("success");
      await browserExpect(page.getByTestId("upload-row")).toHaveCount(1);
      await page
        .locator("#picloom-preview-tools #language")
        .selectOption("zh-CN");
      await browserExpect(page.getByTestId("upload-row")).toHaveCount(1);
      await page.locator("#picloom-preview-tools #mode").selectOption("dark");
      await browserExpect(page.locator("html")).toHaveClass("dark");
      await page.locator("#picloom-preview-tools #page").selectOption("login");
      await browserExpect(
        page.getByRole("button", { name: "登录", exact: true }),
      ).toBeVisible();
      await browserExpect(page.locator("body")).toHaveCSS(
        "--preview-scene",
        "login",
      );
      await page
        .locator("#picloom-preview-tools #scenario")
        .selectOption("login-error");
      await browserExpect(
        page.getByRole("alert").filter({ hasText: "模拟登录失败" }),
      ).toBeVisible();
      await page.locator("#picloom-preview-tools #page").selectOption("home");
      const componentPath = join(project, "src/Page.vue");
      const component = await readFile(componentPath, "utf8");
      await writeFile(
        componentPath,
        component.replace(
          'v-if="s.site.homeTitle"',
          'data-hmr="updated" v-if="s.site.homeTitle"',
        ),
      );
      await browserExpect(page.locator('[data-hmr="updated"]')).toBeVisible();
      const stylePath = join(project, "src/style.css");
      const style = await readFile(stylePath, "utf8");
      await writeFile(stylePath, style + "\nh1 { letter-spacing: 1.23px; }\n");
      await browserExpect(page.locator('[data-hmr="updated"]')).toHaveCSS(
        "letter-spacing",
        "1.23px",
      );
      // Repeated page changes must not accumulate event handlers or rendered roots.
      for (const name of ["login", "home", "login", "home"])
        await page.locator("#picloom-preview-tools #page").selectOption(name);
      await browserExpect(page.getByTestId("upload-input")).toHaveCount(1);
      await page
        .locator("#picloom-preview-tools #scenario")
        .selectOption("no-profiles");
      await browserExpect(
        page.getByRole("button", { name: "选择文件", exact: true }),
      ).toBeDisabled();
      await page
        .locator("#picloom-preview-tools #scenario")
        .selectOption("failed");
      await browserExpect(page.getByTestId("upload-row")).toContainText(
        "模拟上传失败",
      );
      await page
        .locator("#picloom-preview-tools #scenario")
        .selectOption("ready");
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(["mock"], "pasted.png", { type: "image/png" }),
        );
        document.body.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      await browserExpect(page.getByTestId("upload-row")).toHaveCount(1);
      expect(errors).toEqual([]);
      await writeFile(
        entryPath,
        `import type { ThemeContext } from "@picloom/theme-sdk";
export async function mount(container: HTMLElement, context: ThemeContext) {
  const page = context.getSnapshot().page;
  const marker = document.createElement("p");
  marker.dataset.asyncPage = page;
  marker.textContent = page;
  container.append(marker);
  if (page === "home") {
    await new Promise<void>(resolve => window.addEventListener("finish-preview-mount", () => resolve(), { once: true }));
    context.subscribe(() => { document.body.dataset.staleSubscription = "called"; });
    document.body.dataset.asyncFinished = "yes";
  }
  return { dispose() { marker.remove(); } };
}`,
      );
      await browserExpect(
        page.locator('[data-async-page="home"]'),
      ).toBeVisible();
      await page.locator("#picloom-preview-tools #page").selectOption("login");
      await browserExpect(
        page.locator('[data-async-page="login"]'),
      ).toBeVisible();
      await page.evaluate(() =>
        window.dispatchEvent(new Event("finish-preview-mount")),
      );
      await browserExpect(page.locator("body")).toHaveAttribute(
        "data-async-finished",
        "yes",
      );
      await page.locator("#picloom-preview-tools #mode").selectOption("dark");
      expect(
        await page.locator("body").getAttribute("data-stale-subscription"),
      ).toBeNull();
      await browserExpect(page.locator('[data-async-page="home"]')).toHaveCount(
        0,
      );
      await writeFile(entryPath, "export function mount() { return {}; }");
      await browserExpect(
        page.locator("#picloom-preview-tools output"),
      ).toContainText("mount() must return { dispose() }");
      dev.kill("SIGTERM");
      await dev.exited;
      dev = undefined;
      await writeFile(entryPath, entry);
      await writeFile(componentPath, component);
      await writeFile(stylePath, style);
      await run(["bun", "run", "build"], project);
      const bytes = new Uint8Array(
        await readFile(
          join(project, "dist", `${manifest.id}-${manifest.version}.zip`),
        ),
      );
      const files = archiveFiles(bytes);
      expect([...files.keys()].sort()).toEqual([
        "LICENSE",
        "assets/home.css",
        "assets/登录.css",
        "entry.js",
        "style.css",
        "theme.json",
      ]);
      expect(await readFile(join(project, "dev/config.json"), "utf8")).toBe(
        JSON.stringify({ heading: { "en-US": "" }, rows: [] }),
      );
      const built = await start(true);
      production = built.child;
      await page.goto(built.url);
      await browserExpect(page.getByTestId("upload-input")).toHaveCount(1);
      await browserExpect(page.locator("body")).toHaveCSS(
        "--preview-scene",
        "home",
      );
      await page.locator("#picloom-preview-tools #page").selectOption("login");
      await browserExpect(page.locator("body")).toHaveCSS(
        "--preview-scene",
        "login",
      );
      await page.locator("#picloom-preview-tools #page").selectOption("home");
      await browserExpect(page.locator("body")).toHaveCSS(
        "--preview-scene",
        "home",
      );
      await writeFile(
        componentPath,
        component.replace(
          'v-if="s.site.homeTitle"',
          'data-source-only="yes" v-if="s.site.homeTitle"',
        ),
      );
      await page.reload();
      await browserExpect(page.locator('[data-source-only="yes"]')).toHaveCount(
        0,
      );
      production.kill("SIGTERM");
      await production.exited;
      production = undefined;
      const installed = await f.app.themes.inspect(bytes);
      await f.app.themes.install(installed.ticket, true);
      await f.app.themes.activate({
        id: manifest.id,
        version: manifest.version,
      });
      host = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => handler(f.app)(request),
      });
      const hostUrl = `http://127.0.0.1:${host.port}`;
      f.app.config.origin = hostUrl;
      await page.goto(hostUrl + "/login");
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("test-password-123");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await browserExpect(page).toHaveURL(hostUrl + "/app/images");
      await page.goto(hostUrl);
      await page.getByTestId("upload-input").setInputFiles({
        name: "real.png",
        mimeType: "image/png",
        buffer: Buffer.from(f.png),
      });
      await browserExpect(page.getByTestId("upload-row")).toContainText(
        "Uploaded",
      );
      const result = page.getByRole("textbox", {
        name: manifest.messages["en-US"]["uploads.result"],
        exact: true,
      });
      await browserExpect(result).toHaveValue(/^https?:\/\//);
      const downloaded = await fetch(
        new URL(new URL(await result.inputValue()).pathname, hostUrl),
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-type")).toContain("image/");
      await downloaded.arrayBuffer();
      await mkdir(join(project, "public/assets"), { recursive: true });
      await symlink(manifestPath, join(project, "public/assets/linked.json"));
      const rejected = await run(["bun", "run", "build"], project, false);
      expect(rejected.code).not.toBe(0);
      expect(rejected.err).toContain("symbolic links");
      expect(
        await Bun.file(
          join(project, "dist", `${manifest.id}-${manifest.version}.zip`),
        ).exists(),
      ).toBe(false);
      await rm(join(project, "public/assets/linked.json"));
      await writeFile(join(assets, "invalid name.css"), "body {}");
      const invalidPath = await run(["bun", "run", "build"], project, false);
      expect(invalidPath.code).not.toBe(0);
      expect(invalidPath.err).toContain("Not a distributable theme asset");
      await rm(join(assets, "invalid name.css"));
      manifest.styles = [];
      await writeFile(manifestPath, JSON.stringify(manifest));
      const missingStyle = await run(["bun", "run", "build"], project, false);
      expect(missingStyle.code).not.toBe(0);
      expect(missingStyle.err).toContain("declare it in theme.json styles");
      // A valid identity must remove stale output even when the remaining manifest is invalid.
      const archive = join(
        project,
        "dist",
        `${manifest.id}-${manifest.version}.zip`,
      );
      for (const patch of [
        { author: " " },
        { pages: {} },
        { supportedLocales: [] },
      ]) {
        await writeFile(archive, "stale ZIP");
        await writeFile(
          manifestPath,
          JSON.stringify({ ...manifest, ...patch }),
        );
        const invalid = await run(["bun", "run", "build"], project, false);
        expect(invalid.code).not.toBe(0);
        expect(invalid.err).toContain("Invalid theme.json");
        expect(await Bun.file(archive).exists()).toBe(false);
      }
      expect(errors).toEqual([]);
    } finally {
      dev?.kill("SIGTERM");
      production?.kill("SIGTERM");
      if (dev) await dev.exited;
      if (production) await production.exited;
      await host?.stop(true);
      await browser.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
