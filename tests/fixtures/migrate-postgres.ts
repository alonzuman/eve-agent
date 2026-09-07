import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** Test files execute concurrently; serialize their shared database migrations. */
export async function migrateTestDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(628714903)");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  } finally {
    await client.query("SELECT pg_advisory_unlock(628714903)").finally(() => client.release());
  }
}
