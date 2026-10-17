import sharp from "sharp";
import { bootstrap } from "../src/bootstrap";
import { hash } from "../src/core/auth";
const app = await bootstrap(
  {
    root: process.env.TEST_ROOT!,
    encryptionKey: "ab".repeat(32),
    origin: "http://localhost",
    secureCookie: false,
  },
  {
    afterWrite: async () => {
      process.exit(23);
    },
  },
);
const login = await app.auth.login("admin", "test-password-123", "worker");
const identity = await app.db.read((r) =>
  app.auth.verify(r, "session", hash(login.secret)),
);
const profile = (await app.db.read((r) => r.profiles()))[0]!;
const png = await sharp({
  create: { width: 5, height: 5, channels: 3, background: "red" },
})
  .png()
  .toBuffer();
await app.files.upload(
  new File([new Uint8Array(png)], "crash.png"),
  profile.id,
  identity,
  new AbortController().signal,
);
throw new Error("Fault injection did not exit");
