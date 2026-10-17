import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run from the repository root. ZIP files are build output, not source files.
for (const name of ["path", "storage", "processor"]) {
  const directory = resolve("outputs/examples", name);
  await mkdir(directory, { recursive: true });
  const build = await Bun.build({
    entrypoints: [`examples/${name}/index.ts`],
    outdir: directory,
    target: "bun",
    format: "esm",
    naming: "index.js",
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  await copyFile(`examples/${name}/plugin.json`, `${directory}/plugin.json`);
  const archive = resolve("outputs/examples", `${name}.zip`);
  const result = Bun.spawn(
    [
      "zip",
      "-q",
      "-j",
      archive,
      `${directory}/plugin.json`,
      `${directory}/index.js`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await result.exited) !== 0)
    throw new Error(`Failed to package ${name}; install zip first`);
  console.log(archive);
}
