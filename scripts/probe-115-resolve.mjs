#!/usr/bin/env node
// Read-only: report whether a 115 cid is alive and resolves to itself, or is
// gone (silently falls back to the account root). Usage:
//   node scripts/probe-115-resolve.mjs <cid> [<cid> ...]
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadPan115Cookie } from "./_lib/pan115-cookie.mjs";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await loadPan115Cookie();
const { createPan115CookieClientFromEnv } = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));
const client = createPan115CookieClientFromEnv(process.env);
for (const cid of process.argv.slice(2)) {
  const info = await client.getDirectoryInfo({ directoryId: cid });
  const leaf = info?.path?.[info.path.length - 1];
  console.log(`${cid}: state=${info?.state} leaf=${JSON.stringify(leaf)} -> ${info?.state && String(leaf?.cid) === cid ? "ALIVE (resolves to itself)" : "GONE / not-found"}`);
}
