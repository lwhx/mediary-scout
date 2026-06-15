#!/usr/bin/env node
// Dev-only ad-hoc query helper. Usage: node scripts/dev-db-query.mjs "<sql>"
// Reads MEDIA_TRACK_POSTGRES_URL or defaults to the local dev DB.
import pg from "pg";

const url =
  process.env.MEDIA_TRACK_POSTGRES_URL ||
  "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const sql = process.argv[2];
if (!sql) {
  console.error("usage: node scripts/dev-db-query.mjs \"<sql>\"");
  process.exit(2);
}
const c = new pg.Client(url);
await c.connect();
const r = await c.query(sql);
for (const row of r.rows) {
  console.log(
    Object.entries(row)
      .map(([k, v]) => `${k}=${v && typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("  |  "),
  );
}
console.log(`(${r.rowCount} rows)`);
await c.end();
