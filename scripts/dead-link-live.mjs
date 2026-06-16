#!/usr/bin/env node
// #15 live verification: prove the dead-link loop against REAL PanSou + REAL 115
// test root + REAL Postgres (dev DB). Two halves:
//   (a) FILTER: record a real candidate's key as dead → search again → it's gone
//       from the agent's view.
//   (b) RECORD-ON-FAILURE: transfer the malformed magnet (fail-loud 错误的链接 from
//       #14) → its infohash lands in dead_links.
// Both test rows + the staging dir are cleaned up at the end. TEST ROOT only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) {
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.join(repoRoot, ".env"));

const {
  createPanSouResourceProviderFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createPostgresWorkflowRepositorySync,
  CandidateRegistry,
  RealResourceProviderV2,
  RealStorageV2,
  deadLinkKey,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const POSTGRES = process.env.MEDIA_TRACK_POSTGRES_URL || "postgresql://mediatrack:mediatrack@localhost:5432/media_track";
const repo = createPostgresWorkflowRepositorySync({ connectionString: POSTGRES });
const provider = createPanSouResourceProviderFromEnv();
const executor = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;

const registry = new CandidateRegistry();
const v2provider = new RealResourceProviderV2({ provider, registry, workflowRunId: "deadlink-live", deadLinkStore: repo });
const v2storage = new RealStorageV2({ executor, registry, workflowRunId: "deadlink-live", deadLinkStore: repo });

const recordedForCleanup = [];
let stagingDir = null;

try {
  // ===== (a) FILTER =====
  console.log("=== (a) FILTER: record a real candidate's key as dead → it disappears from search ===");
  const searchA = await v2provider.search("奥本海默 2023");
  console.log(`searchA: ${searchA.candidates.length} candidate(s)`);
  // Pick a candidate whose url we can key (a 115 share or magnet).
  const target = searchA.candidates.find((c) => deadLinkKey(String(registry.get(c.id)?.providerPayload?.url ?? "")));
  if (!target) throw new Error("no keyable candidate in searchA");
  const targetKey = deadLinkKey(String(registry.get(target.id).providerPayload.url));
  console.log(`  chosen candidate ${target.id} → key ${JSON.stringify(targetKey.key)} (${targetKey.kind})`);

  await repo.recordDeadLink({ key: targetKey.key, kind: targetKey.kind, reason: "live-verify (a) synthetic", permanent: true });
  recordedForCleanup.push(targetKey.key);

  // Fresh registry/provider so the snapshot dedup cache doesn't mask the re-filter.
  const registryB = new CandidateRegistry();
  const v2providerB = new RealResourceProviderV2({ provider, registry: registryB, workflowRunId: "deadlink-live-b", deadLinkStore: repo });
  const searchB = await v2providerB.search("奥本海默 2023");
  const stillPresent = searchB.candidates.some((c) => {
    const k = deadLinkKey(String(registryB.get(c.id)?.providerPayload?.url ?? ""));
    return k && k.key === targetKey.key;
  });
  console.log(`searchB: ${searchB.candidates.length} candidate(s); dead key still present? ${stillPresent}`);
  console.log(stillPresent ? "  ❌ FILTER FAILED — dead candidate still shown" : "  ✅ FILTER WORKS — dead candidate dropped before the agent");

  // ===== (b) RECORD-ON-FAILURE =====
  console.log("\n=== (b) RECORD-ON-FAILURE: transfer the malformed magnet (fail-loud) → recorded in dead_links ===");
  const badMagnetUrl = "magnet:?xt=urn:btih:8e39a62e48e3cedb488355d863a4a27df8ed720a2160P";
  const badKey = deadLinkKey(badMagnetUrl);
  // Register a synthetic candidate carrying the malformed magnet, then transfer it.
  const badCandidate = {
    id: "deadlink_live_badmagnet",
    snapshotId: "deadlink-live",
    index: 0,
    title: "奥本海默 (malformed magnet)",
    type: "magnet",
    source: "pansou",
    episodeHints: [],
    qualityHints: [],
    providerPayload: { url: badMagnetUrl },
  };
  registry.record(badCandidate);
  stagingDir = await executor.createDirectory({ name: `deadlink-live-${Date.now()}`, parentId: testRoot });
  const attempt = await v2storage.transferCandidate({ candidateId: badCandidate.id, intoDirectoryId: stagingDir });
  console.log(`  transfer result: ${JSON.stringify(attempt)}`);
  const keys = await repo.listDeadLinkKeys();
  const recorded = keys.includes(badKey.key);
  recordedForCleanup.push(badKey.key);
  console.log(`  dead_links now has ${JSON.stringify(badKey.key)}? ${recorded}`);
  console.log(recorded ? "  ✅ RECORD WORKS — the fail-loud magnet was persisted as dead" : "  ❌ RECORD FAILED");
} finally {
  // Cleanup: never leave a real resource permanently filtered in the dev DB.
  console.log("\n=== cleanup ===");
  const { Client } = await import("pg");
  const c = new Client(POSTGRES);
  await c.connect();
  for (const key of recordedForCleanup) {
    const r = await c.query("delete from dead_links where key=$1", [key]);
    console.log(`  removed dead_link ${JSON.stringify(key)} (${r.rowCount} row)`);
  }
  await c.end();
  if (stagingDir) {
    try {
      await executor.removeDirectory(stagingDir);
      console.log(`  removed staging dir ${stagingDir}`);
    } catch (e) {
      console.log(`  staging cleanup failed: ${e.message}`);
    }
  }
  process.exit(0);
}
