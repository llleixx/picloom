import { expect, test } from "bun:test";
import { createClientIpResolver } from "../src/trusted-proxies";
import { settings } from "../src/config";

test("only trusted IPs and CIDRs can supply a single client IP", () => {
  const resolve = createClientIpResolver([
    "127.0.0.1",
    "172.30.0.0/24",
    "fd12:3456::/64",
    "::1",
  ]);
  const client = "203.0.113.8";
  for (const peer of [
    "127.0.0.1",
    "172.30.0.0",
    "172.30.0.255",
    "fd12:3456::1",
    "::1",
    "::ffff:172.30.0.5",
  ])
    expect(resolve(peer, client)).toBe(client);
  for (const peer of [
    "127.0.0.2",
    "172.30.1.0",
    "172.29.255.255",
    "fd12:3456:0:1::1",
    "203.0.113.9",
    "unknown",
  ])
    expect(resolve(peer, client)).toBe(peer);
  for (const forwarded of [
    null,
    "",
    "203.0.113.8, 203.0.113.9",
    "spoofed",
    "203.0.113.8:1234",
  ])
    expect(resolve("172.30.0.5", forwarded)).toBe("172.30.0.5");
  expect(resolve("172.30.0.5", "2001:db8::1")).toBe("2001:db8::1");
  expect(createClientIpResolver([])("127.0.0.1", client)).toBe("127.0.0.1");
});

test("CIDR prefix boundaries and equivalent IPv6 forms", () => {
  const resolve = createClientIpResolver(["192.0.2.7/32", "2001:db8::7/128"]);
  expect(resolve("192.0.2.7", "203.0.113.1")).toBe("203.0.113.1");
  expect(resolve("192.0.2.8", "203.0.113.1")).toBe("192.0.2.8");
  expect(resolve("2001:0db8:0:0:0:0:0:7", "203.0.113.1")).toBe("203.0.113.1");
  expect(resolve("2001:db8::8", "203.0.113.1")).toBe("2001:db8::8");
  const any = createClientIpResolver(["0.0.0.0/0", "::/0"]);
  expect(any("192.0.2.7", "203.0.113.1")).toBe("203.0.113.1");
  expect(any("2001:db8::7", "203.0.113.1")).toBe("203.0.113.1");
});

test("settings reject malformed proxy entries before startup", () => {
  for (const entry of [
    "localhost",
    "*",
    "192.0.2.1:80",
    "192.0.2.0/33",
    "::/129",
    "192.0.2.0/-1",
    "192.0.2.0/1.5",
    "192.0.2.0/",
    "192.0.2.0/24/1",
    "bad/24",
  ])
    expect(() =>
      settings({ encryptionKey: "ab".repeat(32), trustedProxies: [entry] }),
    ).toThrow("TRUSTED_PROXIES");
  expect(
    settings({
      encryptionKey: "ab".repeat(32),
      trustedProxies: ["192.0.2.0/24", "::1"],
    }).trustedProxies,
  ).toEqual(["192.0.2.0/24", "::1"]);
});

test("Web proxy settings validate, apply immediately and survive restart", async () => {
  const { fixture } = await import("./helpers");
  const f = await fixture();
  const peer = "172.30.0.5",
    forwarded = "203.0.113.8";
  const resolve = () => f.app.delivery.resolveClientIp(peer, forwarded);
  try {
    const initial = f.app.delivery.get();
    expect(resolve()).toBe(peer);
    const response = await f.request("/api/settings", "PUT", {
      ...initial,
      trustedProxies: [" 172.30.0.0/24 ", "::1", "172.30.0.0/24"],
    });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.trustedProxies).toEqual(["172.30.0.0/24", "::1"]);
    expect(resolve()).toBe(forwarded);
    for (const invalid of [
      null,
      "172.30.0.0/24",
      [1],
      [""],
      ["localhost"],
      ["::/129"],
      ["192.0.2.0/33"],
    ]) {
      const rejected = await f.request("/api/settings", "PUT", {
        ...saved,
        trustedProxies: invalid,
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json()).error.fields).toContainEqual({
        path: "/trustedProxies",
        message: expect.any(String),
      });
      expect(resolve()).toBe(forwarded);
    }
    await f.restart();
    expect(resolve()).toBe(forwarded);
    expect(f.app.config.trustedProxies).toEqual(saved.trustedProxies);
    expect(
      (
        await f.request("/api/settings", "PUT", {
          ...saved,
          trustedProxies: [],
        })
      ).status,
    ).toBe(200);
    expect(resolve()).toBe(peer);
    await f.restart();
    expect(resolve()).toBe(peer);
  } finally {
    await f.close();
  }
});

test("existing site settings inherit startup proxies once and preserve an explicitly empty list", async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DeliveryConfiguration } =
    await import("../src/core/delivery-settings");
  const root = await mkdtemp(join(tmpdir(), "picloom-proxy-settings-"));
  const config = () =>
    settings({
      root,
      encryptionKey: "ab".repeat(32),
      trustedProxies: ["127.0.0.1"],
    });
  const open = () => new DeliveryConfiguration(config(), () => {});
  const file = join(root, "site-settings.json");
  try {
    const first = open();
    await first.load();
    expect(first.get().trustedProxies).toEqual(["127.0.0.1"]);
    await first.close();
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.delivery.trustedProxies;
    await writeFile(file, JSON.stringify(legacy));
    const upgraded = open();
    await upgraded.load();
    expect(upgraded.resolveClientIp("127.0.0.1", "203.0.113.8")).toBe(
      "203.0.113.8",
    );
    expect(
      JSON.parse(await readFile(file, "utf8")).delivery.trustedProxies,
    ).toEqual(["127.0.0.1"]);
    await upgraded.save({ ...upgraded.get(), trustedProxies: [] });
    await upgraded.close();
    const reopened = open();
    await reopened.load();
    expect(reopened.get().trustedProxies).toEqual([]);
    expect(reopened.resolveClientIp("127.0.0.1", "203.0.113.8")).toBe(
      "127.0.0.1",
    );
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
