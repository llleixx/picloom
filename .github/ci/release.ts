import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export const repository = "llleixx/picloom";
const image = repository;
const source = `https://github.com/${repository}`;
const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function releaseVersion(tag: string, packageVersion: string) {
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  assert.ok(versionPattern.test(version), "Expected vX.Y.Z or vX.Y.Z-rc.N");
  assert.equal(version, packageVersion, "Tag and package.json version differ");
  return { version, prerelease: version.includes("-rc.") };
}
export function assertRegistryDependencies(
  pkg: Record<string, any>,
  lock: string,
) {
  const local =
    /(?:file:|link:|workspace:|\.local-packages|(?:^|[@\s"'])\.{0,2}[\\/]|(?:^|[@\s"'])[A-Za-z]:[\\/])/;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "overrides",
    "resolutions",
  ]) {
    const walk = (value: unknown) => {
      if (typeof value === "string")
        assert.ok(!local.test(value), `Local dependency in ${section}`);
      else if (value && typeof value === "object")
        for (const child of Object.values(value)) walk(child);
    };
    walk(pkg[section]);
  }
  const locked = Bun.JSONC.parse(lock) as {
    packages?: Record<string, unknown[]>;
    workspaces?: Record<string, Record<string, any>>;
  };
  for (const entry of Object.values(locked.packages ?? {})) {
    for (const resolution of entry.slice(0, 2)) {
      if (typeof resolution === "string")
        assert.ok(
          !local.test(resolution),
          "Lockfile contains local dependencies",
        );
    }
  }
  for (const workspace of Object.values(locked.workspaces ?? {})) {
    assertRegistryDependencies(workspace, "{}");
  }
}
export function compareStable(a: string, b: string) {
  assert.ok(stablePattern.test(a) && stablePattern.test(b));
  const left = a.split(".").map(BigInt),
    right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  return 0;
}
export function shouldUpdateLatest(
  version: string,
  releases: Array<{ tag_name: string; draft: boolean; prerelease: boolean }>,
) {
  if (!stablePattern.test(version)) return false;
  return !releases.some(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      r.tag_name.startsWith("v") &&
      stablePattern.test(r.tag_name.slice(1)) &&
      compareStable(r.tag_name.slice(1), version) > 0,
  );
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${args[0]} ${args[1]} failed: ${err}`);
  return out.trim();
}
export interface Registry {
  get(path: string): Promise<{ value: any; digest: string | null } | null>;
}
function registryClient(): Registry {
  let token: string | undefined;
  return {
    async get(path) {
      if (!token) {
        const response = await fetch(
          `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
          { signal: AbortSignal.timeout(30_000) },
        );
        assert.ok(
          response.ok,
          `Registry token request failed: ${response.status}`,
        );
        token = (await response.json()).token;
        assert.ok(token, "Registry token missing");
      }
      const response = await fetch(
        `https://registry-1.docker.io/v2/${repository}/${path}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept:
              "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 404) return null;
      assert.ok(response.ok, `Registry request failed: ${response.status}`);
      return {
        value: await response.json(),
        digest: response.headers.get("docker-content-digest"),
      };
    },
  };
}
async function inspectPlatform(
  registry: Registry,
  digest: string,
  arch: string,
  version: string,
  sha: string,
) {
  assert.ok(digestPattern.test(digest), "Invalid image digest");
  const manifest = await registry.get(`manifests/${digest}`);
  assert.ok(
    manifest && digestPattern.test(manifest.value.config?.digest),
    "Missing image config",
  );
  const config = await registry.get(`blobs/${manifest.value.config.digest}`);
  assert.ok(config, "Missing image configuration");
  assert.equal(config.value.os, "linux");
  assert.equal(config.value.architecture, arch);
  const labels = config.value.config?.Labels;
  assert.equal(
    labels?.["org.opencontainers.image.revision"],
    sha,
    "Existing image belongs to another commit",
  );
  assert.equal(
    labels?.["org.opencontainers.image.version"],
    version,
    "Existing image version differs",
  );
  assert.equal(
    labels?.["org.opencontainers.image.source"],
    source,
    "Existing image source differs",
  );
}
export async function inspectVersion(
  registry: Registry,
  version: string,
  sha: string,
) {
  const index = await registry.get(`manifests/${version}`);
  if (!index) return null;
  assert.ok(
    index.digest && digestPattern.test(index.digest),
    "Missing version digest",
  );
  assert.ok(
    Array.isArray(index.value.manifests),
    "Expected a multi-platform image",
  );
  const manifests = index.value.manifests;
  assert.equal(manifests.length, 2, "Expected exactly two image platforms");
  for (const arch of ["amd64", "arm64"]) {
    const matches = manifests.filter(
      (m: any) =>
        m.platform?.os === "linux" && m.platform?.architecture === arch,
    );
    assert.equal(matches.length, 1, `Missing or duplicated linux/${arch}`);
    await inspectPlatform(registry, matches[0].digest, arch, version, sha);
  }
  return index.digest;
}
async function metadata() {
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    repository,
    "Release repository mismatch",
  );
  assert.equal(
    process.env.GITHUB_REF_TYPE,
    "tag",
    "Releases require a pushed tag",
  );
  const pkg = await Bun.file("package.json").json();
  const version = releaseVersion(
    process.env.GITHUB_REF_NAME ?? "",
    pkg.version,
  );
  assertRegistryDependencies(pkg, await readFile("bun.lock", "utf8"));
  const sha = await command(["git", "rev-parse", "HEAD"]);
  await command(["git", "merge-base", "--is-ancestor", sha, "origin/main"]);
  return { ...version, sha, tag: `v${version.version}` };
}
async function output(values: Record<string, string | boolean>) {
  assert.ok(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT required");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
}
async function finalize() {
  const { version, prerelease, sha, tag } = await metadata();
  const registry = registryClient();
  let digest = await inspectVersion(registry, version, sha);
  const releases = JSON.parse(
    await command([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ]),
  ).flat();
  const existing = releases.find((r: any) => r.tag_name === tag);
  if (!digest) {
    assert.ok(
      !existing,
      "A Release already exists without a matching version image",
    );
    const refs = [];
    for (const arch of ["amd64", "arm64"]) {
      const candidate = (
        await readFile(join("release-digests", `digest-${arch}.txt`), "utf8")
      ).trim();
      await inspectPlatform(registry, candidate, arch, version, sha);
      refs.push(`${image}@${candidate}`);
    }
    await command([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      `${image}:${version}`,
      ...refs,
    ]);
    digest = await inspectVersion(registry, version, sha);
    assert.ok(digest, "Published version is unavailable");
  }
  const notes = `Image: \`${image}:${version}\`\n\nDigest: \`${image}@${digest}\`\n\nSource: ${source}/commit/${sha}\n\nPlatforms: linux/amd64, linux/arm64\n`;
  if (existing) {
    assert.equal(existing.prerelease, prerelease, "Release channel differs");
    assert.ok(
      existing.body?.includes(`${image}@${digest}`),
      "Existing Release digest differs",
    );
    if (existing.draft)
      await command([
        "gh",
        "release",
        "edit",
        tag,
        "--draft=false",
        "--latest=false",
      ]);
  } else {
    await command([
      "gh",
      "release",
      "create",
      tag,
      "--verify-tag",
      "--title",
      tag,
      "--notes",
      notes,
      "--generate-notes",
      "--latest=false",
      ...(prerelease ? ["--prerelease"] : []),
    ]);
  }
  if (shouldUpdateLatest(version, releases)) {
    await command([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      `${image}:latest`,
      `${image}@${digest}`,
    ]);
    await command(["gh", "release", "edit", tag, "--latest"]);
  }
  console.log(`Published ${image}:${version} at ${digest}`);
}
if (import.meta.main) {
  switch (process.argv[2]) {
    case "prepare": {
      const { version, prerelease, sha } = await metadata();
      const digest = await inspectVersion(registryClient(), version, sha);
      await output({ version, prerelease, sha, existing: digest !== null });
      break;
    }
    case "finalize":
      await finalize();
      break;
    default:
      throw new Error("Expected prepare or finalize");
  }
}
