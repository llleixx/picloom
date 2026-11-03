import { describe, expect, test } from "bun:test";
import {
  assertRegistryDependencies,
  inspectVersion,
  releaseVersion,
  shouldUpdateLatest,
  type Registry,
} from "../.github/ci/release";

describe("release guards", () => {
  test("accepts only matching stable and RC tags", () => {
    expect(releaseVersion("v1.2.3", "1.2.3").prerelease).toBe(false);
    expect(releaseVersion("v1.2.3-rc.2", "1.2.3-rc.2").prerelease).toBe(true);
    for (const tag of [
      "1.2.3",
      "v01.2.3",
      "v1.2",
      "v1.2.3-beta.1",
      "v1.2.3-rc.01",
      "v1.2.3+build",
    ]) {
      expect(() => releaseVersion(tag, tag.slice(1))).toThrow();
    }
    expect(() => releaseVersion("v1.2.3", "1.2.4")).toThrow();
  });
  test("rejects local dependencies in package metadata and lockfiles", () => {
    for (const ref of [
      "file:../sdk",
      "link:../sdk",
      "workspace:*",
      "../sdk",
      "./sdk.tgz",
      "/tmp/sdk",
      "C:\\sdk",
      "pkg@file:../sdk",
    ]) {
      expect(() =>
        assertRegistryDependencies({ dependencies: { sdk: ref } }, "{}"),
      ).toThrow();
      expect(() =>
        assertRegistryDependencies(
          {},
          JSON.stringify({ packages: { sdk: [ref] } }),
        ),
      ).toThrow();
    }
    assertRegistryDependencies(
      {
        dependencies: { sdk: "0.1.0", remote: "https://example.com/sdk.tgz" },
        overrides: { sdk: { nested: "npm:@scope/sdk@1.0.0" } },
      },
      '{"packages":{"sdk":["sdk@1.0.0","https://registry.npmjs.org/sdk/-/sdk-1.0.0.tgz"]}}',
    );
    expect(() =>
      assertRegistryDependencies(
        { overrides: { sdk: { nested: "file:../sdk" } } },
        "{}",
      ),
    ).toThrow();
  });
  test("accepts registry lock metadata containing relative executable paths", async () => {
    assertRegistryDependencies(
      await Bun.file("package.json").json(),
      await Bun.file("bun.lock").text(),
    );
  });
  test("latest never moves to RC or an older stable release", () => {
    const releases = [
      { tag_name: "v1.9.0", draft: false, prerelease: false },
      { tag_name: "v2.0.0-rc.1", draft: false, prerelease: true },
      { tag_name: "v9.0.0", draft: true, prerelease: false },
    ];
    expect(shouldUpdateLatest("1.10.0", releases)).toBe(true);
    expect(shouldUpdateLatest("1.8.0", releases)).toBe(false);
    expect(shouldUpdateLatest("1.9.0", releases)).toBe(true); // Retry can finish the alias.
    expect(shouldUpdateLatest("2.0.0-rc.1", releases)).toBe(false);
  });
});

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
function registryFixture() {
  const entries: Record<string, any> = {
    "manifests/1.2.3": {
      manifests: [
        {
          digest: digest("a"),
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          digest: digest("b"),
          platform: { os: "linux", architecture: "arm64" },
        },
      ],
    },
  };
  for (const [arch, manifest, config] of [
    ["amd64", "a", "c"],
    ["arm64", "b", "d"],
  ]) {
    entries[`manifests/${digest(manifest!)}`] = {
      config: { digest: digest(config!) },
    };
    entries[`blobs/${digest(config!)}`] = {
      os: "linux",
      architecture: arch,
      config: {
        Labels: {
          "org.opencontainers.image.revision": "commit",
          "org.opencontainers.image.version": "1.2.3",
          "org.opencontainers.image.source":
            "https://github.com/llleixx/picloom",
        },
      },
    };
  }
  const registry: Registry = {
    async get(path) {
      return entries[path]
        ? { value: entries[path], digest: digest("e") }
        : null;
    },
  };
  return { entries, registry };
}

describe("immutable version reuse", () => {
  test("reuses a complete matching image and distinguishes an absent version", async () => {
    const { registry } = registryFixture();
    expect(await inspectVersion(registry, "1.2.3", "commit")).toBe(digest("e"));
    expect(await inspectVersion(registry, "1.2.4", "commit")).toBeNull();
  });
  test("refuses conflicts in either platform and incomplete manifests", async () => {
    for (const field of [
      "org.opencontainers.image.revision",
      "org.opencontainers.image.version",
      "org.opencontainers.image.source",
    ]) {
      const { entries, registry } = registryFixture();
      entries[`blobs/${digest("d")}`].config.Labels[field] = "different";
      await expect(
        inspectVersion(registry, "1.2.3", "commit"),
      ).rejects.toThrow();
    }
    const { entries, registry } = registryFixture();
    entries["manifests/1.2.3"].manifests.pop();
    await expect(inspectVersion(registry, "1.2.3", "commit")).rejects.toThrow();
  });
  test("registry failures do not become permission to overwrite", async () => {
    const registry: Registry = {
      async get() {
        throw new Error("registry unavailable");
      },
    };
    await expect(inspectVersion(registry, "1.2.3", "commit")).rejects.toThrow(
      "registry unavailable",
    );
  });
});
