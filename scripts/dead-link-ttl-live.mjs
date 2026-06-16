#!/usr/bin/env node
// Live-verify the soft-TTL dead-link against the REAL dev Postgres: proves the
// schema ALTER migrated the existing dead_links table (added `permanent`) and the
// SQL TTL filter resurrects a soft magnet link past its TTL while a permanent
// 115-share death never resurrects. Cleans up its rows.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) { let raw; try { raw = readFileSync(p, "utf8"); } catch { return; }
  for (const line of raw.split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq === -1) continue; const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); if (process.env[k] === undefined) process.env[k] = v; } }
loadDotEnv(path.join(repoRoot, ".env"));

const { createPostgresWorkflowRepositorySync } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const POSTGRES = process.env.MEDIA_TRACK_POSTGRES_URL || "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const repo = createPostgresWorkflowRepositorySync({ connectionString: POSTGRES });

const t0 = "2026-06-16T00:00:00.000Z";
const softKey = "magnet:ttl_live_test_hash", permKey = "115:ttl_live_test_share";
let pass = true;
try {
  await repo.recordDeadLink({ key: permKey, kind: "pan115", reason: "分享已取消", permanent: true, now: t0 });
  await repo.recordDeadLink({ key: softKey, kind: "magnet", reason: "no 秒传", permanent: false, now: t0 });

  const within = new Set(await repo.listDeadLinkKeys({ now: "2026-06-18T00:00:00.000Z" })); // +2d
  const past = new Set(await repo.listDeadLinkKeys({ now: "2026-07-16T00:00:00.000Z" }));   // +30d

  const a = within.has(softKey) && within.has(permKey);
  const b = !past.has(softKey) && past.has(permKey);
  console.log(`within TTL (+2d): soft=${within.has(softKey)} perm=${within.has(permKey)}  ${a ? "✅ both filtered" : "❌"}`);
  console.log(`past TTL (+30d):  soft=${past.has(softKey)} perm=${past.has(permKey)}  ${b ? "✅ soft resurrected, perm stays dead" : "❌"}`);
  pass = a && b;
} finally {
  const { Client } = await import("pg");
  const c = new Client(POSTGRES); await c.connect();
  const r = await c.query("delete from dead_links where key = any($1)", [[softKey, permKey]]);
  console.log(`cleanup: removed ${r.rowCount} test row(s)`);
  await c.end();
}
console.log(pass ? "\n✅ PASS — Postgres TTL dead-link works (schema migrated, soft resurrects, permanent stays)" : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
