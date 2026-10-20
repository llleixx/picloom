import { writePointer } from "../../../shared/config";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { logicalKey } from "../../../plugin-sdk/files";
import { Secrets } from "../../infra/secrets";
import { AppError } from "../../core/errors";

// Offline adapter operation: validate before replacing any live data.
export function prepareRestoredDatabase(
  path: string,
  localRoots: Record<string, { root: string; configPath: string }>,
  oldKey: string,
  newKey: string,
) {
  const db = new Database(path, { readwrite: true, create: false });
  try {
    const checksum = createHash("sha256")
      .update(readFileSync(new URL("./001_initial.sql", import.meta.url)))
      .digest("hex");
    const schema = db
      .query("SELECT checksum FROM schema_info WHERE id=1")
      .get() as { checksum: string } | null;
    if (
      schema?.checksum !== checksum ||
      JSON.stringify(db.query("PRAGMA integrity_check").values()) !==
        '[["ok"]]' ||
      db.query("PRAGMA foreign_key_check").all().length ||
      (
        db
          .query(
            "SELECT count(*) AS n FROM users WHERE role='owner' AND status='active'",
          )
          .get() as { n: number }
      ).n !== 1
    )
      throw new AppError(
        "BACKUP_INVALID",
        "Backup database is incompatible or invalid",
      );
    const source = new Secrets(oldKey),
      target = new Secrets(newKey);
    db.exec("BEGIN IMMEDIATE");
    try {
      const instances = db
        .query(
          "SELECT id, config_json, secrets_encrypted FROM plugin_instances",
        )
        .all() as Array<{
        id: string;
        config_json: string;
        secrets_encrypted: string | null;
      }>;
      for (const instance of instances) {
        const config = JSON.parse(instance.config_json);
        const directory = localRoots[instance.id];
        if (directory)
          writePointer(config, directory.configPath, directory.root);
        db.query(
          "UPDATE plugin_instances SET config_json=?,secrets_encrypted=? WHERE id=?",
        ).run(
          JSON.stringify(config),
          instance.secrets_encrypted
            ? target.encrypt(
                source.decrypt(instance.secrets_encrypted, instance.id),
                instance.id,
              )
            : null,
          instance.id,
        );
      }
      const files = db
        .query("SELECT temp_path FROM files WHERE temp_path IS NOT NULL")
        .all() as Array<{ temp_path: string }>;
      for (const file of files) {
        // Uploads store a basename, resolved under the active root at runtime.
        logicalKey(file.temp_path);
        if (file.temp_path.includes("/"))
          throw new AppError("BACKUP_INVALID", "Invalid temporary file path");
      }
      // Restored passwords and upload tokens remain valid; browser sessions must sign in again.
      db.exec("DELETE FROM sessions; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}
