import { Pool } from "pg";
// Every test owns a new schema; never clear the caller's public schema.
export async function isolatedPostgres(connectionString: string) {
  const pool = new Pool({ connectionString });
  const schema = "star_test_" + crypto.randomUUID().replaceAll("-", "");
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString!);
  url.searchParams.set(
    "options",
    (url.searchParams.get("options") ?? "") + ` -c search_path=${schema}`,
  );
  return {
    url: url.toString(),
    async close() {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    },
  };
}
