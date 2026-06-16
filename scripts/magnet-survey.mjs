#!/usr/bin/env node
// Empirical magnet survey to settle the 错位 worry: across a SPECTRUM of titles
// (the incident anime 莉可丽丝, old/niche anime, new anime, new + popular movies),
// pull magnets from real PanSou and transfer each on the 115 TEST ROOT, tightly
// sampling the offline-task statusText + landing dir. Answers:
//   - for ALIVE magnets, how fast does statusText flip to 下载成功? (is it ALWAYS
//     within the ~4s window, or can it lag → false dead-link risk?)
//   - what fraction of niche/old vs new magnets are dead (等待中 forever)?
// Cancels every task + removes every dir. TEST ROOT only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadDotEnv(p) {
  let raw;
  try { raw = readFileSync(p, "utf8"); } catch { return; }
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

const { createPanSouResourceProviderFromEnv, createProtectedPan115CookieStorageExecutorFromEnv, Pan115CookieClient } =
  await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const testRoot = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
const provider = createPanSouResourceProviderFromEnv();
const storage = createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
const client = new Pan115CookieClient({ cookie: process.env.PAN115_COOKIE });

const TITLES = [
  ["莉可丽丝 2022", "anime ~2022 (the incident)"],
  ["凉宫春日的忧郁", "anime 2006 (old/niche)"],
  ["孤独摇滚", "anime 2022 (popular)"],
  ["间谍过家家", "anime 2022 (very popular)"],
  ["哪吒之魔童闹海 2025", "movie 2025 (new+popular)"],
  ["某种物质 2024", "movie 2024 (niche-ish)"],
];
const MAX_PER_TITLE = 3;
const MAX_TOTAL = 14;

const infoHashOf = (u) => (u.match(/btih:([0-9a-fA-F]{40})/) ?? [])[1]?.toLowerCase() ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- collect magnets across titles (dedup by infohash) ---
const seen = new Set();
const magnets = [];
for (const [kw, note] of TITLES) {
  if (magnets.length >= MAX_TOTAL) break;
  let snapshot;
  try { snapshot = await provider.search({ keyword: kw, workflowRunId: "survey" }); }
  catch (e) { console.log(`search "${kw}" failed: ${e.message}`); continue; }
  let n = 0;
  for (const c of snapshot.candidates) {
    const url = String(c.providerPayload?.url ?? "");
    const h = infoHashOf(url);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    magnets.push({ kw, note, url, hash: h, title: String(c.title ?? "").slice(0, 50) });
    n += 1;
    if (n >= MAX_PER_TITLE || magnets.length >= MAX_TOTAL) break;
  }
  console.log(`search "${kw}" (${note}): +${n} magnet(s)`);
}
console.log(`\nCollected ${magnets.length} unique magnets to probe.\n${"=".repeat(74)}`);

// --- probe each magnet ---
const results = [];
for (const m of magnets) {
  const dir = await storage.createDirectory({ name: `survey-${Date.now()}-${m.hash.slice(0, 6)}`, parentId: testRoot });
  const tAdd = Date.now();
  const add = await client.addOfflineTask({ url: m.url, directoryId: dir });
  let successText = null, successAt = null, landedAt = null, lastStatusText = add.message || "";
  if (add.ok && !add.alreadyTransferred) {
    for (let i = 0; i < 6; i += 1) {
      await sleep(1800);
      const el = (Date.now() - tAdd) / 1000;
      try {
        const tree = await storage.listTree({ directoryId: dir });
        if (landedAt === null && tree.some((f) => /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i.test(f.path))) landedAt = el;
      } catch {}
      try {
        const tasks = await client.listOfflineTasks({ page: 1 });
        const t = tasks.find((x) => x.infoHash?.toLowerCase() === m.hash);
        if (t) {
          lastStatusText = t.statusText;
          if (successAt === null && /成功|完成/.test(t.statusText)) { successAt = el; successText = t.statusText; }
        }
      } catch {}
      if (landedAt !== null && successAt !== null) break;
    }
  }
  const alive = successAt !== null || landedAt !== null;
  results.push({ ...m, ok: add.ok, already: !!add.alreadyTransferred, alive, successAt, landedAt, lastStatusText, addMsg: add.message });
  console.log(
    `${alive ? "✅活" : add.alreadyTransferred ? "↻已存在" : !add.ok ? "✗拒" : "💀死"} [${m.note}] ${m.title}` +
    `\n     add=${JSON.stringify(add.message || "ok")} 下载成功@${successAt ?? "-"}s 落盘@${landedAt ?? "-"}s last="${lastStatusText}"`,
  );
  if (!add.alreadyTransferred) { try { await client.removeOfflineTask({ infoHashes: [m.hash] }); } catch {} }
  try { await storage.removeDirectory(dir); } catch {}
}

// --- summary: the key numbers for the 错位 decision ---
const alive = results.filter((r) => r.alive);
const successTimes = alive.map((r) => r.successAt).filter((x) => x !== null);
const dead = results.filter((r) => r.ok && !r.already && !r.alive);
console.log(`\n${"=".repeat(74)}\nSUMMARY (${results.length} magnets):`);
console.log(`  alive (秒传): ${alive.length}   dead (等待中, no 秒传): ${dead.length}   已存在: ${results.filter((r) => r.already).length}   fail-loud拒: ${results.filter((r) => !r.ok).length}`);
if (successTimes.length) {
  console.log(`  下载成功 first-seen times: ${successTimes.map((t) => t.toFixed(1) + "s").join(", ")}`);
  console.log(`  >>> MAX 下载成功 time = ${Math.max(...successTimes).toFixed(1)}s  (window is ~4s base / ~8s extended)`);
  console.log(`  >>> all within 4s? ${successTimes.every((t) => t <= 4) ? "YES — window safe" : "NO — some lag past 4s → false dead-link risk"}`);
}
const landTimes = alive.map((r) => r.landedAt).filter((x) => x !== null);
if (landTimes.length) console.log(`  landing times: ${landTimes.map((t) => t.toFixed(1) + "s").join(", ")} (max ${Math.max(...landTimes).toFixed(1)}s)`);
console.log("\nDone.");
