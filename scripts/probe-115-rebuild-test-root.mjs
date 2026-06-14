#!/usr/bin/env node
// Rebuild a clean test library structure under the 115 TEST ROOT:
//   <test root>/电影   (movies)
//   <test root>/电视剧 (tv)
//   <test root>/动画   (anime)
// so the dev workflow routes by media type instead of dumping everything in the
// root. Hard-pinned to the test root cid. Read-only unless --apply.
//
//   node scripts/probe-115-rebuild-test-root.mjs          # verify root + list
//   node scripts/probe-115-rebuild-test-root.mjs --apply  # create the 3 dirs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPan115Cookie } from "./_lib/pan115-cookie.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] = v; // force: .env is the source of truth for this probe
}

const PROD = "3339812358359874597";
const TEST_ROOT = process.env.MEDIA_TRACK_115_TEST_ROOT_CID;
if (!TEST_ROOT) {
  console.error("ABORT: MEDIA_TRACK_115_TEST_ROOT_CID is not set");
  process.exit(1);
}
if (TEST_ROOT === PROD) {
  console.error("ABORT: test root equals production cid — refusing");
  process.exit(1);
}

// The live 115 cookie lives in Postgres (app_settings.pan115.cookie), set via
// QR login; the .env value is a stale bootstrap fallback. Hydrate from Postgres,
// exactly like the runtime does. Tolerant: fall back to the .env cookie if absent.
try {
  await loadPan115Cookie();
} catch (error) {
  console.error(`(could not hydrate cookie from Postgres: ${String(error)}; using .env)`);
}

const apply = process.argv.includes("--apply");
const { createPan115CookieClientFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const client = createPan115CookieClientFromEnv(process.env);

// 1. Reliable existence check: /files echoes the cid it actually resolved, so
//    listItems throws PAN115_DIRECTORY_NOT_FOUND when the cid is gone (resolved
//    to root). getDirectoryInfo's path is NOT reliable here — category/get omits
//    the id for dirs directly under root, so a valid root-child looks "gone".
let items;
try {
  items = await client.listItems({ directoryId: TEST_ROOT });
} catch (error) {
  if (!String(error?.message ?? error).includes("PAN115_DIRECTORY_NOT_FOUND")) throw error;
  console.error(
    `\nTEST ROOT ${TEST_ROOT} IS GONE — 115 resolves it to the account root. You deleted it.\n` +
      `--apply will create a fresh structure at the real root (cid 0):\n` +
      `  0/media-track-test/{Movies,TV,Anime}\n` +
      `then print the new cids for .env.`,
  );
  if (!process.argv.includes("--apply")) process.exit(2);
  // One container under root (not 3 bare dirs polluting the account root), with
  // English category names.
  const container = await client.createFolder({ name: "media-track-test", parentId: "0" });
  console.log(`created container "media-track-test" -> ${container}`);
  const env = { MEDIA_TRACK_115_TEST_ROOT_CID: String(container) };
  const categories = [
    ["Movies", "MEDIA_TRACK_MOVIES_PARENT_CID"],
    ["TV", "MEDIA_TRACK_TV_PARENT_CID"],
    ["Anime", "MEDIA_TRACK_ANIME_PARENT_CID"],
  ];
  for (const [name, key] of categories) {
    const sub = await client.createFolder({ name, parentId: String(container) });
    env[key] = String(sub);
    console.log(`  created media-track-test/${name} -> ${sub}`);
  }
  console.log("\n=== .env ===");
  for (const [key, val] of Object.entries(env)) console.log(`${key}=${val}`);
  process.exit(0);
}
console.log(`test root ${TEST_ROOT} exists with ${items.length} children:`);
for (const it of items) {
  const isFolder = it.fid === undefined || it.fid === null || it.fid === "";
  console.log(`  ${isFolder ? "[DIR ]" : "[file]"} ${String(isFolder ? it.cid : it.fid).padEnd(20)} ${it.n}`);
}

const wanted = ["电影", "电视剧", "动画"];
const existing = new Map(items.filter((it) => it.fid == null).map((it) => [it.n, String(it.cid)]));

if (!apply) {
  console.log("\n(dry run) would ensure these category dirs exist under the test root:");
  for (const name of wanted) console.log(`  ${name} ${existing.has(name) ? "(exists " + existing.get(name) + ")" : "(create)"}`);
  console.log("\npass --apply to create the missing ones.");
  process.exit(0);
}

const result = {};
for (const name of wanted) {
  if (existing.has(name)) {
    result[name] = existing.get(name);
    console.log(`exists  ${name} -> ${result[name]}`);
    continue;
  }
  const newId = await client.createFolder({ name, parentId: TEST_ROOT });
  result[name] = String(newId);
  console.log(`created ${name} -> ${result[name]}`);
}

console.log("\n=== set these in .env so dev routes by media type ===");
console.log(`MEDIA_TRACK_MOVIES_PARENT_CID=${result["电影"]}`);
console.log(`MEDIA_TRACK_TV_PARENT_CID=${result["电视剧"]}`);
console.log(`MEDIA_TRACK_ANIME_PARENT_CID=${result["动画"]}`);
