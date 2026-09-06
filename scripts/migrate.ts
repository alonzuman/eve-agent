import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString?.trim()) throw new Error("Set DATABASE_URL_UNPOOLED or DATABASE_URL before running migrations.");
const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
try {
  await client.connect();
  // One direct connection holds the lock across Drizzle's migration transaction.
  await client.query("SELECT pg_advisory_lock(628714903)");
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)) });
  console.info("Database migrations are current.");
} catch {
  console.error("Database migration failed. Check connectivity, database privileges, and the generated migrations.");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
