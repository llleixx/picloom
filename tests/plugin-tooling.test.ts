import { expect, test } from "bun:test";
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
import { archiveFiles } from "../src/plugins/archive";
import { fixture } from "./helpers";
import { list } from "tar";

const repository = resolve(import.meta.dir, "..");
async function runCommand(
  cmd: string[],
  cwd: string,
  success: boolean,
  path: string,
) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, NODE_PATH: "", PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (success && code !== 0)
    throw new Error(`${cmd.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  return { code, stdout, stderr };
}

// Explicit opt-in: downloads dependencies. Child commands can only find Bun on PATH.
const toolingTest =
  process.env.PICLOOM_TEST_PLUGIN_TOOLING === "1" ? test : test.skip;
toolingTest(
  "packed SDK and creator work outside the repo and produce installable plugins",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "picloom-tooling-"));
    const f = await fixture();
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await symlink(process.execPath, join(bin, "bun"));
      await symlink(process.execPath, join(bin, "bunx"));
      expect(Bun.which("node", { PATH: bin })).toBeNull();
      expect(Bun.which("npm", { PATH: bin })).toBeNull();
      const run = (cmd: string[], cwd: string, success = true) =>
        runCommand(cmd, cwd, success, bin);
      await run(["bun", "run", "build:plugin-sdk"], repository);
      const pack = async (directory: string) => {
        const output = join(root, directory.replaceAll("/", "-") + ".tgz");
        await run(
          [
            "bun",
            "pm",
            "pack",
            "--ignore-scripts",
            "--filename",
            output,
            "--quiet",
          ],
          join(repository, directory),
        );
        const entries: string[] = [];
        await list({
          file: output,
          onReadEntry: (entry) => {
            entries.push(entry.path);
          },
        });
        expect(entries.some((path) => path.includes("node_modules"))).toBe(
          false,
        );
        expect(entries).toContain("package/package.json");
        return output;
      };
      const sdk = await pack("plugin-sdk");
      const creator = await pack("tools/create-plugin");
      const launcher = join(root, "launcher");
      await mkdir(launcher);
      await writeFile(join(launcher, "package.json"), '{"private":true}');
      await run(["bun", "add", "--ignore-scripts", creator], launcher);
      const cli = join(
        launcher,
        "node_modules/@picloom/create-plugin/index.js",
      );
      await run([cli, "--help"], root);
      const project = join(root, "my-plugin");
      await run(["bun", "create", "@picloom/plugin", project], launcher);
      expect(await Bun.file(join(project, ".gitignore")).exists()).toBe(true);
      const originalManifest = await readFile(
        join(project, "plugin.json"),
        "utf8",
      );
      const conflict = await run([cli, project], root, false);
      expect(conflict.code).not.toBe(0);
      expect(await readFile(join(project, "plugin.json"), "utf8")).toBe(
        originalManifest,
      );
      expect((await run([cli, "--unknown"], root, false)).code).not.toBe(0);
      // Substitute a real local tarball because the SDK is deliberately not published yet.
      const packagePath = join(project, "package.json");
      const pkg = await Bun.file(packagePath).json();
      pkg.devDependencies["@picloom/plugin-sdk"] = `file:${sdk}`;
      await Bun.write(packagePath, JSON.stringify(pkg));
      await run(["bun", "install", "--ignore-scripts"], project);
      await run(["bun", "run", "build"], project);
      const manifest = JSON.parse(originalManifest);
      const artifact = () =>
        join(project, "dist", `${manifest.id}-${manifest.version}.zip`);
      const install = async () => {
        const bytes = await Bun.file(artifact()).bytes();
        expect([...archiveFiles(bytes).keys()].sort()).toEqual([
          "index.js",
          "plugin.json",
        ]);
        const form = new FormData();
        form.set("file", new File([bytes], "plugin.zip"));
        const inspection = await f.request(
          "/api/plugins/inspect",
          "POST",
          form,
        );
        expect(inspection.status).toBe(200);
        const installed = await f.request("/api/plugins/install", "POST", {
          ticket: (await inspection.json()).ticket,
          confirmTrusted: true,
        });
        expect(installed.status).toBe(201);
        expect((await installed.json()).status).toBe("loaded");
      };
      await install();
      const profile = await f.app.configuration.profileEditor(f.profileId);
      await f.app.configuration.saveProfileEditor(
        {
          ...profile,
          expectedVersion: profile.configVersion,
          path: {
            pluginId: manifest.id,
            version: manifest.version,
            config: {},
          },
        },
        profile.id,
      );
      const uploaded = await f.upload();
      expect(uploaded.status).toBe(201);
      const file = await uploaded.json();
      const row = await f.app.db.read((r) => r.file(file.id));
      expect(row?.logical_key).toMatch(/^\d{4}\/\d{2}\/\d{2}\/[^/]+\.png$/);
      const download = await f.request(new URL(file.url).pathname);
      expect(download.status).toBe(200);
      await download.arrayBuffer();

      manifest.version = "0.1.1";
      await Bun.write(join(project, "plugin.json"), JSON.stringify(manifest));
      const sourcePath = join(project, "src/index.ts");
      const pathSource = await readFile(sourcePath, "utf8");
      await Bun.write(
        sourcePath,
        pathSource.replace("`${date}/${fileId}", "`updated/${date}/${fileId}"),
      );
      await run(["bun", "run", "build"], project);
      await install();
      const beforeUpgrade = await f.app.configuration.profileEditor(
        f.profileId,
      );
      expect(beforeUpgrade.path.version).toBe("0.1.0");
      const preview = await f.app.plugins.previewUpgrade(
        beforeUpgrade.path.key!,
        manifest.version,
      );
      await f.app.configuration.saveProfileEditor(
        {
          ...beforeUpgrade,
          expectedVersion: beforeUpgrade.configVersion,
          path: preview.configuration,
        },
        beforeUpgrade.id,
      );
      const upgradedUpload = await f.upload();
      expect(upgradedUpload.status).toBe(201);
      const upgradedFile = await upgradedUpload.json();
      const upgradedRow = await f.app.db.read((r) => r.file(upgradedFile.id));
      expect(upgradedRow?.logical_key).toStartWith("updated/");

      // Validate SDK declarations and Sharp types using a second real stage implementation.
      manifest.id = "example.resize";
      manifest.name = "Resize";
      manifest.kind = "processor";
      manifest.version = "1.0.0";
      await Bun.write(join(project, "plugin.json"), JSON.stringify(manifest));
      const processor = (
        await readFile(join(repository, "examples/processor/index.ts"), "utf8")
      ).replace('"../../plugin-sdk"', '"@picloom/plugin-sdk"');
      await Bun.write(join(project, "src/index.ts"), processor);
      await run(["bun", "run", "build"], project);
      await install();
      const pipeline = await f.app.configuration.savePipeline({
        name: "Standalone SDK resize",
        kind: "upload",
        steps: [
          {
            pluginId: manifest.id,
            version: manifest.version,
            config: { width: 8 },
            enabledParams: [],
            onNotApplicable: "abort",
          },
        ],
      });
      const updatedProfile = await f.app.configuration.profileEditor(
        f.profileId,
      );
      await f.app.configuration.saveProfileEditor(
        {
          ...updatedProfile,
          expectedVersion: updatedProfile.configVersion,
          uploadPipelineId: pipeline.id,
        },
        updatedProfile.id,
      );
      const resized = await f.upload();
      expect(resized.status).toBe(201);
      const resizedFile = await resized.json();
      const resizedRow = await f.app.db.read((r) => r.file(resizedFile.id));
      expect(resizedRow?.width).toBe(8);

      // A copied example must not silently produce an archive with mismatched identity.
      manifest.version = "2.0.0";
      await Bun.write(join(project, "plugin.json"), JSON.stringify(manifest));
      const mismatch = await run(["bun", "run", "build"], project, false);
      expect(mismatch.code).not.toBe(0);
      expect(mismatch.stderr).toContain("does not match");
    } finally {
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
