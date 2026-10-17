import { isolatedPostgres } from "./postgres-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  bootstrap,
  initializeDevelopment,
  type Application,
} from "../src/bootstrap";
import { handler } from "../src/http/app";
import type { Faults } from "../src/core/files";
export async function fixture(faults: Faults = {}, databaseUrl = "") {
  const pgScope =
    !databaseUrl && process.env.TEST_FIXTURE_POSTGRES_URL
      ? await isolatedPostgres(process.env.TEST_FIXTURE_POSTGRES_URL)
      : undefined;
  databaseUrl ||= pgScope?.url ?? "";
  const root = await mkdtemp(join(tmpdir(), "picloom-"));
  const overrides = {
    databaseUrl,
    root,
    encryptionKey: "ab".repeat(32),
    origin: "http://localhost",
    secureCookie: false,
  };
  let app = await bootstrap(overrides, faults);
  await app.auth.initialize("admin", "test-password-123");
  const profileId = await initializeDevelopment(app);
  let handle = handler(app);
  let cookie = "",
    csrf = "";
  const uploadKeys = new Map<string, string>();
  const request = async (
    path: string,
    method = "GET",
    value?: unknown,
    token?: string,
  ) => {
    const headers = new Headers();
    if (token) headers.set("authorization", "Bearer " + token);
    else if (cookie) {
      headers.set("cookie", cookie);
      headers.set("x-csrf-token", csrf);
    }
    const uploadId = path.match(/^\/api\/uploads\/([^/]+)/)?.[1];
    if (uploadId && uploadKeys.has(uploadId))
      headers.set("x-upload-key", uploadKeys.get(uploadId)!);
    let body: BodyInit | undefined;
    if (value instanceof FormData) body = value;
    else if (value !== undefined) {
      body = JSON.stringify(value);
      headers.set("content-type", "application/json");
    }
    const result = await handle(
      new Request("http://localhost" + path, { method, headers, body }),
    );
    if (path === "/api/uploads" && method === "POST" && result.ok) {
      const value = await result.clone().json();
      uploadKeys.set(value.id, value.uploadKey);
    }
    return result;
  };
  const login = async () => {
    const response = await request("/api/auth/login", "POST", {
      username: "admin",
      password: "test-password-123",
    });
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const data = await (await request("/api/auth/session")).json();
    csrf = data.csrfToken;
  };
  await login();
  const png = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 20, g: 100, b: 180, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const upload = async (
    token?: string,
    bytes: Uint8Array = png,
    name = "image.png",
  ) => {
    const form = new FormData();
    form.set("profileId", profileId);
    form.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
    return request("/api/files", "POST", form, token);
  };
  return {
    root,
    uploadKeys,
    overrides,
    get app() {
      return app;
    },
    profileId,
    request,
    login,
    upload,
    png,
    get cookie() {
      return cookie;
    },
    get csrf() {
      return csrf;
    },
    async restart() {
      await app.close();
      app = await bootstrap(overrides, faults);
      handle = handler(app);
    },
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
      await pgScope?.close();
    },
  };
}
