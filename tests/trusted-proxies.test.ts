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
