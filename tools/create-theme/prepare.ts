import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const output = resolve(import.meta.dir, "dist/template");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(import.meta.dir, "template"), output, { recursive: true });
await cp(resolve(root, "themes/default/src"), output + "/src", {
  recursive: true,
});
await cp(resolve(root, "themes/default/theme.json"), output + "/theme.json");
await cp(resolve(root, "LICENSE"), output + "/LICENSE");
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/helpers.ts")],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!built.success) throw new Error(built.logs.join("\n"));
await writeFile(output + "/dev/helpers.js", await built.outputs[0]!.text());
console.log(output);
