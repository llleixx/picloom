import { mkdir, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const names = ["path", "storage", "processor", "access", "post-save"];
await mkdir(resolve(root, "outputs/examples"), { recursive: true });
for (const name of names)
  await rm(resolve(root, "outputs/examples", `${name}.zip`), { force: true });
for (const name of names) {
  const directory = resolve(import.meta.dir, name);
  const result = Bun.spawn(
    [process.execPath, resolve(root, "node_modules/@picloom/plugin-tools/dist/cli.js"), "build"],
    { cwd: directory, stdout: "inherit", stderr: "inherit" },
  );
  if (await result.exited) throw Error(`Failed to build ${name}`);
  const manifest = await Bun.file(resolve(directory, "plugin.json")).json();
  const archive = resolve(root, "outputs/examples", `${name}.zip`);
  await copyFile(
    resolve(directory, "dist", `${manifest.id}-${manifest.version}.zip`),
    archive,
  );
  console.log(archive);
}
