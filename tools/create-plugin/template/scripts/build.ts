import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import manifest from "../plugin.json";

if (
  !/^[a-z][a-z0-9._-]{0,99}$/.test(manifest.id) ||
  manifest.id.startsWith("builtin.") ||
  !/^[0-9][a-zA-Z0-9.+-]{0,63}$/.test(manifest.version) ||
  !["path", "storage", "processor"].includes(manifest.kind) ||
  manifest.apiVersion !== 1 ||
  manifest.entry !== "index.js" ||
  !manifest.name.trim() ||
  manifest.name.length > 100
)
  throw new Error(
    "Invalid plugin.json: check id, name, version, kind, apiVersion and entry",
  );

const build = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "bun",
  format: "esm",
  naming: "index.js",
  plugins: [
    {
      name: "host-sharp",
      setup(builder) {
        builder.onResolve({ filter: /^sharp(?:\/|$)/ }, () => {
          throw new Error(
            "Use services.images.sharp; do not import the Sharp runtime",
          );
        });
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.join("\n"));
if (build.outputs.length !== 1 || build.outputs[0]?.kind !== "entry-point")
  throw new Error(
    "This template packages one JavaScript entry only; additional assets need explicit packaging",
  );
const code = await build.outputs[0].text();
// Bundling must leave only Bun/Node builtins. Do not ship unresolved packages/assets.
const imports = new Bun.Transpiler({ loader: "js", target: "bun" }).scanImports(
  code,
);
const { isBuiltin } = await import("node:module");
for (const item of imports) {
  if (
    item.path !== "bun" &&
    !item.path.startsWith("bun:") &&
    !isBuiltin(item.path)
  )
    throw new Error(`Unbundled runtime import: ${item.path}`);
}
// Evaluate the developer's own entry to catch a mismatched/missing default export.
// Keep plugin top-level code free of network requests and other side effects.
const { default: definition } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
for (const field of ["id", "version", "kind", "apiVersion"] as const) {
  if (definition?.[field] !== manifest[field])
    throw new Error(
      `Plugin default export does not match plugin.json: ${field}`,
    );
}
const zip = zipSync({
  "plugin.json": strToU8(JSON.stringify(manifest, null, 2) + "\n"),
  "index.js": strToU8(code),
});
if (zip.byteLength > 20 * 1024 * 1024)
  throw new Error("Plugin ZIP exceeds Picloom's 20 MiB upload limit");
await mkdir("dist", { recursive: true });
const output = resolve("dist", `${manifest.id}-${manifest.version}.zip`);
await Bun.write(output, zip);
console.log(output);
