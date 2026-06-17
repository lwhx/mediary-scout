// Live e2e: real Prowlarr (LAN) → magnet candidates with infohash; Composite
// merges PanSou + Prowlarr into one snapshot. Run: npx tsx scripts/prowlarr-e2e.mts
import {
  ProwlarrResourceProvider,
  CompositeResourceProvider,
  PanSouResourceProvider,
} from "@media-track/workflow";

const PROWLARR = { baseURL: "http://192.168.100.1:9696", apiKey: "d5dd35656d9e4287b16613e033ed52c6" };
const PANSOU = "http://192.168.100.1:8888";

async function main() {
  const prowlarr = new ProwlarrResourceProvider(PROWLARR);

  // 1. Prowlarr alone: a well-seeded movie → magnet candidates with infohash.
  const snap = await prowlarr.search({ keyword: "Oppenheimer 2023" });
  const withHash = snap.candidates.filter((c) => typeof c.providerPayload.infoHash === "string" && c.providerPayload.infoHash);
  console.log(`prowlarr "Oppenheimer 2023": ${snap.candidates.length} candidates, ${withHash.length} with infohash`);
  const sample = snap.candidates[0];
  if (sample) {
    console.log(`  sample: [${sample.source}] ${sample.title.slice(0, 50)} → ${String(sample.providerPayload.url).slice(0, 60)}`);
  }
  if (snap.candidates.length === 0) throw new Error("expected Prowlarr magnet candidates");
  if (snap.candidates.some((c) => c.type !== "magnet")) throw new Error("all Prowlarr candidates must be magnet");
  if (withHash.length !== snap.candidates.length) throw new Error("every candidate should carry an infohash");

  // 2. Composite: PanSou + Prowlarr merged into one snapshot, deduped.
  const composite = new CompositeResourceProvider({
    providers: [
      { name: "pansou", provider: new PanSouResourceProvider({ baseURL: PANSOU }) },
      { name: "prowlarr", provider: prowlarr },
    ],
  });
  const merged = await composite.search({ keyword: "Oppenheimer 2023" });
  const sources = new Set(merged.candidates.map((c) => c.source));
  const hashes = merged.candidates.map((c) => c.providerPayload.infoHash).filter(Boolean) as string[];
  const dupes = hashes.length - new Set(hashes.map((h) => h.toLowerCase())).size;
  console.log(`composite: provider=${merged.provider}, ${merged.candidates.length} merged candidates from sources {${[...sources].join(", ")}}, infohash dupes=${dupes}`);
  if (merged.provider !== "composite") throw new Error("expected composite provider tag");
  if (merged.candidates.length === 0) throw new Error("expected merged candidates");
  if (dupes !== 0) throw new Error(`composite should dedupe by infohash, found ${dupes} dupes`);

  console.log("✅ prowlarr e2e passed: real magnet candidates + composite merge/dedupe");
}

main().catch((error) => {
  console.error("❌", error);
  process.exit(1);
});
