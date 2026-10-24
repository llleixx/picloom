import { expect, test } from "bun:test";
import { handler } from "../src/http/app";
import { fixture } from "./helpers";

test("favicon follows current branding publicly without caching or self redirects", async () => {
  const f = await fixture();
  try {
    const handle = handler(f.app);
    const current = f.app.delivery.get();
    for (const [icon, location] of [
      ["/assets/picloom.svg", "http://localhost/assets/picloom.svg"],
      [
        "https://assets.example/favicon.ico",
        "https://assets.example/favicon.ico",
      ],
      ["", null],
      ["http://localhost/favicon.ico?version=1", null],
      ["https://images.example/favicon.ico", null],
    ] as const) {
      await f.app.delivery.save({
        ...current,
        imageOrigin: "https://images.example",
        siteFaviconUrl: icon,
      });
      for (const method of ["GET", "HEAD"]) {
        const response = await handle(
          new Request("http://localhost/favicon.ico", { method }),
        );
        expect(response.status).toBe(location ? 302 : 404);
        expect(response.headers.get("location")).toBe(location);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe("");
      }
    }
    expect(
      (
        await handle(
          new Request("http://localhost/favicon.ico", { method: "POST" }),
        )
      ).status,
    ).toBe(405);
  } finally {
    await f.close();
  }
});
