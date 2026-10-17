import { runtimeDefaults } from "../shared/runtime-settings";
import { test, expect } from "bun:test";
import { fixture } from "./helpers";
import { handler } from "../src/http/app";
import { rename, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

test("delivery settings require admin/CSRF, validate, apply live and survive restart", async () => {
  const f = await fixture();
  try {
    const handle = handler(f.app);
    expect(
      (await handle(new Request("http://localhost/api/settings"))).status,
    ).toBe(401);
    const token = await (
      await f.request("/api/tokens", "POST", { name: "upload" })
    ).json();
    expect(
      (await f.request("/api/settings", "GET", undefined, token.token)).status,
    ).toBe(403);
    expect(
      (await f.request("/api/settings", "PUT", {}, token.token)).status,
    ).toBe(403);
    const value = {
      ...runtimeDefaults,
      guestMaxUploadBytes: null,
      guestDailyUploadLimit: null,
      cacheBytes: 1048576,
      cacheTtlMs: 60000,
      publicOrigin: "http://localhost",
      imageOrigin: "https://images.example.com/",
      imageCacheMaxAge: 600,
      hotlinkEnabled: true,
      hotlinkAllowedHosts: ["EXAMPLE.COM", "*.example.com", "example.com"],
      hotlinkAllowEmpty: false,
    };
    expect(
      (
        await handle(
          new Request("http://localhost/api/settings", {
            method: "PUT",
            headers: { cookie: f.cookie },
            body: JSON.stringify(value),
          }),
        )
      ).status,
    ).toBe(403);
    for (const changes of [
      { cacheBytes: 0 },
      { cacheTtlMs: -1 },
      { publicOrigin: "" },
      { publicOrigin: "https://user:pass@example.com" },
      { publicOrigin: "https://example.com/path" },
      { imageOrigin: "https://example.com/path" },
      { imageOrigin: "https://user:secret@example.com" },
      { hotlinkEnabled: "true" },
      { hotlinkAllowedHosts: ["https://example.com"] },
      { hotlinkAllowedHosts: ["-bad.com"] },
      { encryptionKey: "no" },
      { imageCacheMaxAge: -1 },
      { imageCacheMaxAge: 1.5 },
      { imageCacheMaxAge: "600" },
    ]) {
      const response = await f.request("/api/settings", "PUT", {
        ...value,
        ...changes,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.fields.length).toBeGreaterThan(0);
    }
    const saved = await f.request("/api/settings", "PUT", value);
    expect(saved.status).toBe(200);
    const normalized = await saved.json();
    expect(normalized.imageOrigin).toBe("https://images.example.com");
    expect(normalized.hotlinkAllowedHosts).toEqual([
      "example.com",
      "*.example.com",
    ]);
    const uploaded = await (await f.upload()).json();
    expect(uploaded.url).toStartWith(normalized.imageOrigin);
    const path = new URL(uploaded.url).pathname;
    expect((await f.request(path)).status).toBe(403);
    const allowed = await handle(
      new Request("http://localhost" + path, {
        headers: { referer: "https://example.com/article" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe(
      "public, max-age=600, must-revalidate",
    );
    expect(allowed.headers.get("vary")).toBeNull();
    await allowed.arrayBuffer();
    await f.restart();
    expect(await (await f.request("/api/settings")).json()).toEqual(normalized);
    expect((await f.request(path)).status).toBe(403);
    const reset = { ...normalized, imageOrigin: null, hotlinkEnabled: false };
    expect((await f.request("/api/settings", "PUT", reset)).status).toBe(200);
    expect(f.app.config.imageOrigin).toBe(f.app.config.origin);
    expect(f.app.config.imageCacheMaxAge).toBe(600);
    const image = await f.request(path);
    expect(image.status).toBe(200);
    await image.arrayBuffer();
    await f.restart();
    expect(f.app.config.imageOrigin).toBe(f.app.config.origin);
    expect(f.app.config.imageCacheMaxAge).toBe(600);
  } finally {
    await f.close();
  }
});

test("a failed settings write leaves the active and saved configuration intact", async () => {
  const f = await fixture();
  const file = join(f.root, "delivery-settings.json");
  try {
    const current = await (await f.request("/api/settings")).json();
    await f.request("/api/settings", "PUT", current);
    await rename(file, file + ".backup");
    await mkdir(file);
    expect(
      (
        await f.request("/api/settings", "PUT", {
          ...current,
          hotlinkEnabled: true,
        })
      ).status,
    ).toBe(500);
    expect(await (await f.request("/api/settings")).json()).toEqual(current);
    await rm(file, { recursive: true });
    await rename(file + ".backup", file);
    await f.restart();
    expect(await (await f.request("/api/settings")).json()).toEqual(current);
  } finally {
    await f.close();
  }
});

test("site origin updates API checks, cookies and fallback image URLs, including restart", async () => {
  const f = await fixture();
  try {
    const current = await (await f.request("/api/settings")).json();
    const updated = {
      ...current,
      publicOrigin: "https://site.example.com/",
      imageOrigin: null,
    };
    expect((await f.request("/api/settings", "PUT", updated)).status).toBe(200);
    const check = async () => {
      expect(f.app.config.origin).toBe("https://site.example.com");
      expect(f.app.config.imageOrigin).toBe("https://site.example.com");
      expect(f.app.auth.cookie("test")).toContain("; Secure");
      const handle = handler(f.app);
      for (const [origin, status] of [
        ["http://localhost", 403],
        ["https://site.example.com", 200],
      ] as const) {
        const response = await handle(
          new Request("https://site.example.com/api/settings", {
            headers: { origin, cookie: f.cookie },
          }),
        );
        expect(response.status).toBe(status);
      }
    };
    await check();
    await f.restart();
    await check();
    const uploaded = await (await f.upload()).json();
    expect(uploaded.url).toStartWith("https://site.example.com/i/");
    await f.request("/api/settings", "PUT", {
      ...updated,
      publicOrigin: "http://localhost",
      imageOrigin: "https://images.example.com",
    });
    expect(f.app.config.imageOrigin).toBe("https://images.example.com");
    expect(f.app.auth.cookie("test")).not.toContain("; Secure");
  } finally {
    await f.close();
  }
});

test("site branding persists with settings and is public, normalized and validated", async () => {
  const f = await fixture();
  try {
    const current = await (await f.request("/api/settings")).json();
    expect(current.siteName).toBe("");
    const branding = {
      siteName: "  My Gallery  ",
      siteDescription: "  Private images  ",
      siteLogoUrl: "https://assets.example/logo.svg",
      siteFaviconUrl: "https://assets.example/favicon.ico",
    };
    for (const changes of [
      { siteName: "a".repeat(101) },
      { siteDescription: 123 },
      { siteLogoUrl: "javascript:alert(1)" },
      { siteFaviconUrl: "data:image/png;base64,AA" },
      { siteLogoUrl: "https://user:secret@example.com/logo.png" },
    ]) {
      expect(
        (await f.request("/api/settings", "PUT", { ...current, ...changes }))
          .status,
      ).toBe(400);
    }
    const saved = await (
      await f.request("/api/settings", "PUT", { ...current, ...branding })
    ).json();
    expect(saved.siteName).toBe("My Gallery");
    expect(saved.siteDescription).toBe("Private images");
    await f.restart();
    expect(await (await f.request("/api/settings")).json()).toEqual(saved);
    const publicSettings = await (
      await handler(f.app)(new Request("http://localhost/api/client-settings"))
    ).json();
    for (const key of Object.keys(branding))
      expect(publicSettings[key]).toBe(saved[key]);
    const staleCookie = await handler(f.app)(
      new Request("http://localhost/api/client-settings", {
        headers: { cookie: "session=expired" },
      }),
    );
    expect(staleCookie.status).toBe(200);
    expect((await staleCookie.json()).siteName).toBe("My Gallery");
    expect(publicSettings.publicOrigin).toBeUndefined();
    expect(publicSettings.hotlinkAllowedHosts).toBeUndefined();
    const reset = await (
      await f.request("/api/settings", "PUT", {
        ...saved,
        siteName: "  ",
        siteDescription: "",
        siteLogoUrl: "",
        siteFaviconUrl: "",
      })
    ).json();
    expect(reset.siteName).toBe("");
    expect(reset.siteLogoUrl).toBe("");
    expect(reset.cacheBytes).toBe(current.cacheBytes);
  } finally {
    await f.close();
  }
});
