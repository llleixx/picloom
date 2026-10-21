import {
  mkdir,
  readdir,
  readFile,
  lstat,
  writeFile,
  cp,
  rm,
} from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { build } from "vite";
import { zipSync, strToU8 } from "fflate";
import { assetPath, readManifest } from "./manifest";
const manifest = await readManifest();
const output = resolve("dist/package");
const archive = resolve("dist", `${manifest.id}-${manifest.version}.zip`);
// A failed build must not leave an older ZIP looking like the new result.
await rm(archive, { force: true });
await build();
async function files(root: string): Promise<string[]> {
  if ((await lstat(root)).isSymbolicLink())
    throw Error(`Do not package symbolic links: ${root}`);
  const result: string[] = [];
  for (const name of await readdir(root)) {
    const path = resolve(root, name),
      stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw Error(`Do not package symbolic links: ${path}`);
    if (stat.isDirectory()) result.push(...(await files(path)));
    else if (stat.isFile()) result.push(path);
    else throw Error(`Unsupported file: ${path}`);
  }
  return result;
}
try {
  for (const path of await files(resolve("public/assets"))) {
    const name = relative(resolve("public"), path).replaceAll("\\", "/");
    if (
      !assetPath(name) ||
      /(?:^|\/)\./.test(name) ||
      /\.(?:map|env|pem|key|ts|vue)$/i.test(name)
    )
      throw Error(`Not a distributable theme asset: ${name}`);
    const destination = resolve(output, name);
    if (await Bun.file(destination).exists())
      throw Error(`Asset collides with build output: ${name}`);
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await cp("LICENSE", output + "/LICENSE");
const declaration = JSON.stringify(manifest, null, 2) + "\n";
if (strToU8(declaration).byteLength > 256 * 1024)
  throw Error("theme.json exceeds 256 KiB");
await writeFile(output + "/theme.json", declaration);
const entries: Record<string, Uint8Array> = {};
const names = new Set<string>();
let total = 0;
for (const path of await files(output)) {
  const name = relative(output, path).replaceAll("\\", "/");
  if (
    !assetPath(name) ||
    names.has(name.toLowerCase()) ||
    /(?:^|\/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\/|$)/i.test(name) ||
    /(?:^|\/)\./.test(name) ||
    name.endsWith(".map")
  )
    throw Error(`Invalid or duplicate package path: ${name}`);
  names.add(name.toLowerCase());
  const bytes = new Uint8Array(await readFile(path));
  total += bytes.byteLength;
  if (total > 50 * 1024 * 1024 || names.size > 512)
    throw Error("Theme exceeds 50 MiB expanded or 512 files");
  if (/\.m?js$/.test(name)) {
    const code = new TextDecoder().decode(bytes);
    const imports = new Bun.Transpiler({
      loader: "js",
      target: "browser",
    }).scanImports(code);
    if (imports.length)
      throw Error(
        `Unbundled runtime imports in ${name}; this template produces a self-contained entry`,
      );
    if (
      /["'`]\/(?:@vite|@id|@fs|src|dev)\/|localhost:\d|127\.0\.0\.1:\d|\/\/[#@]\s*sourceMappingURL=/.test(
        code,
      )
    )
      throw Error(`Development reference in ${name}`);
  }
  if (
    name.endsWith(".css") &&
    /localhost:\d|127\.0\.0\.1:\d|(?:url|@import)\s*\(?["']?\/(?:src|dev|@vite)\//.test(
      new TextDecoder().decode(bytes),
    )
  )
    throw Error(`Development reference in ${name}`);
  entries[name] = bytes;
}
if (entries["style.css"] && !manifest.styles?.includes("style.css"))
  throw Error(
    "The template bundles imported CSS into style.css; declare it in theme.json styles",
  );
for (const name of [
  ...(manifest.styles ?? []),
  ...(manifest.preview ? [manifest.preview] : []),
  ...Object.values(manifest.pages).flatMap((page) => [
    page.entry,
    ...(page.styles ?? []),
  ]),
]) {
  if (!entries[name]) throw Error(`Missing theme resource: ${name}`);
}
const zip = zipSync(entries);
if (zip.byteLength > 20 * 1024 * 1024) throw Error("Theme ZIP exceeds 20 MiB");
await Bun.write(archive, zip);
console.log(archive);
