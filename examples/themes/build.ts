import { mkdir, copyFile, cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
const available = ["horizon"];
const names = process.argv.slice(2).length ? process.argv.slice(2) : available;
for (const name of names) {
  if (!available.includes(name)) throw new Error(`Unknown theme: ${name}`);
  const source = `examples/themes/${name}`,
    out = resolve(`outputs/themes/${name}`);
  const build = Bun.spawn(
    ["bun", "--bun", "vite", "build", "--config", `${source}/vite.config.ts`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await build.exited) throw new Error("Theme build failed");
  await mkdir(out, { recursive: true });
  await copyFile(`${source}/theme.json`, out + "/theme.json");
  if (name === "horizon")
    await cp(`${source}/assets`, out + "/assets", { recursive: true });
  const archive = resolve(`outputs/themes/${name}.zip`);
  await rm(archive, { force: true });
  const pack = Bun.spawn(["zip", "-q", "-r", archive, "."], {
    cwd: out,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await pack.exited) throw new Error("ZIP packaging failed; install zip");
  console.log(archive);
}
