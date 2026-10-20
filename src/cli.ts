import { settings } from "./config";
import { Auth } from "./core/auth";
import { workLock } from "./infra/files";
import { openPersistence } from "./persistence/open";
import type { Persistence } from "./persistence/port";
import { bootstrap, initializeDevelopment } from "./bootstrap";
import { promptOwnerPassword } from "./cli-password";
const command = process.argv[2];
if (
  !["init-db", "init-admin", "init-dev", "reset-owner-password"].includes(
    command ?? "",
  )
)
  throw new Error(
    "Usage: bun src/cli.ts init-db|init-admin|init-dev|reset-owner-password",
  );
if (command === "reset-owner-password") {
  console.info(
    "Stop the application before recovery; existing Owner sessions will be signed out.",
  );
  const config = settings();
  const unlock = await workLock(config.root);
  let db: Persistence | undefined;
  try {
    db = await openPersistence(config);
    const password = await promptOwnerPassword();
    const username = await new Auth(db, config).recoverOwnerPassword(password);
    console.info(
      `Owner password reset for ${username}; existing sessions signed out. Upload tokens retained.`,
    );
  } finally {
    await db?.close();
    await unlock();
  }
} else {
  const app = await bootstrap();
  try {
    if (command === "init-admin") {
      const username = process.env.ADMIN_USERNAME ?? "admin";
      const password = process.env.ADMIN_PASSWORD;
      if (!password)
        throw new Error("Set ADMIN_PASSWORD (at least 6 characters)");
      console.info(
        (await app.auth.initialize(username, password))
          ? "Administrator created"
          : "Administrator already exists; unchanged",
      );
    }
    if (command === "init-dev")
      console.info(
        JSON.stringify({ profileId: await initializeDevelopment(app) }),
      );
    if (command === "init-db") console.info("Database initialized");
  } finally {
    await app.close();
  }
}
