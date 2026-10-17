import { join } from "node:path";
import type { Settings } from "../config";
import type { Persistence } from "./port";
import { openSQLite } from "./sqlite/store";
import { openPostgres } from "./postgres/store";
export async function openPersistence(
  config: Pick<Settings, "root" | "databaseUrl">,
): Promise<Persistence> {
  return config.databaseUrl
    ? openPostgres(config.databaseUrl)
    : openSQLite(join(config.root, "database.sqlite"));
}
