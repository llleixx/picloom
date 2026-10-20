import { crc32 } from "../src/plugins/archive";
import { deflateRawSync } from "node:zlib";
export function zip(
  entries: Record<string, string>,
  options: { deflate?: boolean; mode?: number } = {},
) {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(entries)) {
    const name = Buffer.from(path),
      data = Buffer.from(text),
      raw = options.deflate ? deflateRawSync(data) : data,
      method = options.deflate ? 8 : 0,
      crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, raw);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(raw.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((options.mode ?? 0x81a4) * 65536) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + raw.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export const demoCode = `export default {id:'example.date',defaultLocale:"en-US",content:{"en-US":{name:'Example path plugin'}},version:'1.0.0',kind:'path',apiVersion:1,configSchemaVersion:1,configSchema:{type:'object',properties:{},additionalProperties:false},async createInstance(){return {async generate({fileId}){return {logicalKey:'example/'+fileId+'.png'}}}}}`;
export function demoPackage(code = demoCode) {
  return zip(
    {
      "plugin.json": JSON.stringify({
        id: "example.date",

        version: "1.0.0",
        kind: "path",
        apiVersion: 1,
        entry: "index.js",
      }),
      "index.js": code,
    },
    { deflate: true },
  );
}

// Build a self-contained external package: no imports back into the application.
export async function bundledPackage(id: string, kind: string, source: string) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "star-plugin-build-"));
  try {
    const entry = join(dir, "index.ts");
    await Bun.write(entry, source);
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    return zip({
      "plugin.json": JSON.stringify({
        id,

        kind,
        version: "1.0.0",
        apiVersion: 1,
        entry: "index.js",
      }),
      "index.js": await build.outputs[0]!.text(),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function externalBuiltin(
  name: string,
  symbol: string,
  id: string,
  kind: string,
) {
  const path = new URL(
    `../src/builtins/${kind}/${name}/index.ts`,
    import.meta.url,
  ).pathname;
  return bundledPackage(
    id,
    kind,
    `import { ${symbol} } from ${JSON.stringify(path)}; export default { ...${symbol}, id: ${JSON.stringify(id)}, defaultLocale: "en-US", content: { ...${symbol}.content, "en-US": { ...${symbol}.content["en-US"], name: ${JSON.stringify(id)} } } };`,
  );
}
