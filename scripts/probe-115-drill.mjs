#!/usr/bin/env node
// READ-ONLY: drill from a cid into its first subdirectory at each level and
// print the breadcrumb 115 returns, to verify /files carries the FULL ancestor
// chain for deep directories. No writes, no recursive video collection.
//   node scripts/probe-115-drill.mjs <cid>
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPan115Cookie } from "./_lib/pan115-cookie.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cookie = await loadPan115Cookie();
const { Pan115CookieClient } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const client = new Pan115CookieClient({ cookie, listLimit: 5000 });
let cid = process.argv[2];
for (let depth = 0; depth < 6; depth += 1) {
  const info = await client.getDirectoryInfo({ directoryId: cid });
  const crumb = info?.path?.map((p) => `${p.cid}:${p.name}`).join(" / ");
  console.log(`depth ${depth} (len ${info?.path?.length}): ${crumb}`);
  if (!info?.state) break;
  let items;
  try { items = await client.listItems({ directoryId: cid }); }
  catch (e) { console.log("  stop:", String(e?.message ?? e).split(".")[0]); break; }
  const dir = items.find((it) => it.fid === undefined || it.fid === null || it.fid === "");
  if (!dir) { console.log("  (leaf — no subdirectory)"); break; }
  cid = String(dir.cid);
}
