// Shared probe-script helper: load .env and pull the live 115 cookie from
// Postgres (app_settings key "pan115.cookie"), then set process.env.PAN115_COOKIE.
// The SQLite dev DB has been retired — credentials now live in Postgres, decoupled
// from disposable test data. Returns the cookie string (also sets the env var).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadDotEnv(envPath = path.join(repoRoot, ".env")) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[t.slice(0, i).trim()] === undefined) process.env[t.slice(0, i).trim()] = v;
  }
}

export async function loadPan115Cookie() {
  loadDotEnv();
  const connectionString = process.env.MEDIA_TRACK_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("MEDIA_TRACK_POSTGRES_URL is required (the SQLite dev DB has been retired)");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query("SELECT value FROM app_settings WHERE key = $1", ["pan115.cookie"]);
    const cookie = result.rows[0]?.value;
    if (!cookie) {
      throw new Error("No pan115.cookie in Postgres app_settings — is the 115 account scanned/connected?");
    }
    process.env.PAN115_COOKIE = String(cookie);
    return String(cookie);
  } finally {
    await client.end();
  }
}
