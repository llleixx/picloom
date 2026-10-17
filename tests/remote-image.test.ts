import { test, expect } from "bun:test";
import { publicImageAddress, downloadImage } from "../src/infra/remote-image";
import { fixture } from "./helpers";
test("remote image download rejects local, reserved and mapped addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.2",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    expect(publicImageAddress(address)).toBe(false);
  expect(publicImageAddress("8.8.8.8")).toBe(true);
  expect(publicImageAddress("2606:4700:4700::1111")).toBe(true);
  for (const url of [
    "http://127.1/image.png",
    "http://[::1]/x",
    "file:///etc/passwd",
    "https://user:secret@example.com/x",
  ])
    await expect(
      downloadImage(url, 1024, new AbortController().signal),
    ).rejects.toThrow();
});
test("URL uploads authorize before downloading and reject local URLs", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: f.profileId,
          url: "http://127.0.0.1/a.png",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: "missing",
          url: "https://example.com/a.png",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.request("/api/files/from-url", "POST", {
          profileId: f.profileId,
          url: 42,
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
