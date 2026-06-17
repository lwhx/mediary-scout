// PanSou query CLI for the search-recipe research. Read-only (no 115).
// Prints, per keyword: candidate count + top result titles (so an agent can JUDGE
// relevance — is the top hit actually the target work? — and read quality tokens).
//
//   node scripts/pansou-query.mjs "<kw1>" "<kw2>" ...
// Output per keyword is a compact block the agent can parse/eyeball.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[k] ??= v;
}

const { createPanSouResourceProviderFromEnv } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);
const provider = createPanSouResourceProviderFromEnv();

const keywords = process.argv.slice(2);
if (keywords.length === 0) {
  console.error('usage: node scripts/pansou-query.mjs "<keyword>" ["<keyword2>" ...]');
  process.exit(1);
}

const TOP = 15;
for (const kw of keywords) {
  try {
    const snap = await provider.search({ keyword: kw, workflowRunId: "recipe-research" });
    const titles = snap.candidates.map((c) => c.title ?? "");
    console.log(`\n### KEYWORD: ${JSON.stringify(kw)}  →  ${titles.length} candidates`);
    titles.slice(0, TOP).forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.slice(0, 110)}`));
    if (titles.length > TOP) console.log(`  … +${titles.length - TOP} more`);
  } catch (e) {
    console.log(`\n### KEYWORD: ${JSON.stringify(kw)}  →  ERROR ${e.message}`);
  }
}
