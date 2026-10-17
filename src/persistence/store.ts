import { type Kysely } from "kysely";
import { Conflict } from "../core/errors";
import type { Persistence, Repositories } from "./port";
import { SqlRepositories, type Schema } from "./repositories";
function translate(error: unknown): never {
  const code =
    error instanceof Error && "code" in error ? String(error.code) : "";
  if (
    code.startsWith("SQLITE_CONSTRAINT") ||
    ["23502", "23503", "23505", "23514", "40001", "40P01"].includes(code)
  )
    throw new Conflict();
  throw error;
}
export class SqlStore implements Persistence {
  constructor(
    private db: Kysely<Schema>,
    private dialect: "sqlite" | "postgres",
  ) {}
  private async scope<T>(
    read: boolean,
    fn: (r: Repositories) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        let transaction = this.db.transaction();
        if (this.dialect === "postgres")
          transaction = transaction.setIsolationLevel(
            read ? "repeatable read" : "serializable",
          );
        return await transaction.execute(async (tx) => {
          const r = new SqlRepositories(tx, this.dialect);
          try {
            return await fn(r);
          } finally {
            r.active = false;
          }
        });
      } catch (error) {
        const code =
          error instanceof Error && "code" in error ? String(error.code) : "";
        // PostgreSQL has already rolled back these transactions. Retry database work only.
        if (
          this.dialect === "postgres" &&
          attempt < 2 &&
          ["40001", "40P01"].includes(code)
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1)),
          );
          continue;
        }
        translate(error);
      }
    }
  }
  read<T>(fn: (r: Repositories) => Promise<T>) {
    return this.scope(true, fn);
  }
  transaction<T>(fn: (r: Repositories) => Promise<T>) {
    return this.scope(false, fn);
  }
  close() {
    return this.db.destroy();
  }
}
