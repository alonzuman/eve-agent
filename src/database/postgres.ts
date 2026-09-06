import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
let database: Database | undefined;

/** Lazy: builds and non-Linq sessions do not need a database connection. */
export function getDatabase(): Database {
  if (database) return database;
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("Message storage is not configured. Set DATABASE_URL and run the migrations.");
  const pool = new Pool({
    connectionString, max: 3, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000, statement_timeout: 10_000, application_name: "eve-messaging",
  });
  pool.on("error", () => console.warn("[messaging] idle database connection failed"));
  attachDatabasePool(pool);
  database = drizzle(pool, { schema });
  return database;
}
