#!/usr/bin/env node
// Read-only: dump the raw 115 /files response keys + breadcrumb for a cid, to
// see whether /files alone carries the ancestor path (could replace category/get).
//   node scripts/probe-115-raw-files.mjs <cid>
import { loadPan115Cookie } from "./_lib/pan115-cookie.mjs";
const cookie = await loadPan115Cookie();
const cid = process.argv[2];
const url = `https://webapi.115.com/files?aid=1&cid=${cid}&offset=0&limit=2&show_dir=1&format=json`;
const res = await fetch(url, { headers: { Cookie: cookie, "User-Agent": "Mozilla/5.0" } });
const json = await res.json();
console.log("top-level keys:", Object.keys(json).join(", "));
console.log("echoed cid:", json.cid, "| count:", json.count);
console.log("path/breadcrumb:", JSON.stringify(json.path ?? json.paths ?? "(none)"));
