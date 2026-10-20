#!/usr/bin/env bun
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
  console.log("Usage: bun create @picloom/plugin <new-directory>");
} else if (args.length !== 1 || args[0].startsWith("-")) {
  console.error("Usage: bun create @picloom/plugin <new-directory>");
  process.exitCode = 1;
} else {
  try {
    const target = resolve(args[0]);
    // Refuse even empty existing directories: never merge into a user's project.
    await mkdir(target);
    const template = fileURLToPath(new URL("./template/", import.meta.url));
    for (const entry of await readdir(template)) {
      await cp(resolve(template, entry), resolve(target, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    // Package managers may rename/omit .gitignore when packing, so ship it under a plain name.
    await rename(resolve(target, "gitignore"), resolve(target, ".gitignore"));
    const name =
      basename(target)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-")
        .replace(/^[^a-z]+/, "")
        .slice(0, 80) || "my-plugin";
    const manifestPath = resolve(target, "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.id = `example.${name}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const packagePath = resolve(target, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    pkg.name = name;
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(
      `Created ${target}\n\nNext:\n  cd ${JSON.stringify(args[0])}\n  bun install\n  bun run build\n\nUpload dist/${manifest.id}-${manifest.version}.zip to Picloom.`,
    );
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "Target already exists. Choose a new directory; no existing files were changed."
        : `Could not create plugin: ${error.message}`,
    );
    process.exitCode = 1;
  }
}
