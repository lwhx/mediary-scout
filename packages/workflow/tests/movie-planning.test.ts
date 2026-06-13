import { describe, expect, it } from "vitest";
import { FakeAgentNodes, type ResourceSnapshot } from "../src/index.js";

function snapshot(id: string, titles: string[]): ResourceSnapshot {
  return {
    id,
    provider: "fake",
    keyword: "movie",
    candidates: titles.map((title, index) => ({
      id: `${id}_c${index + 1}`,
      snapshotId: id,
      index,
      title,
      type: "115",
      source: "fake",
      episodeHints: [],
      qualityHints: [],
      providerPayload: {},
    })),
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

describe("FakeAgentNodes.planMovieAcquisition", () => {
  it("selects exactly one candidate mapped to the movie's single episode", async () => {
    const agents = new FakeAgentNodes();
    const result = await agents.planMovieAcquisition({
      title: "奥本海默",
      aliases: [],
      year: 2023,
      qualityPreference: "4K",
      initialKeyword: "奥本海默 4K",
      failureEvidence: [],
      searchResources: async () => snapshot("snap_movie", ["奥本海默 4K UHD", "奥本海默 1080p"]),
    });

    expect(result.plan.selectedSnapshotId).toBe("snap_movie");
    // Every candidate gets a disposition (no silent omission).
    expect(result.plan.candidateDispositions).toHaveLength(2);
    const selected = result.plan.candidateDispositions.filter((d) => d.disposition === "selected");
    expect(selected).toHaveLength(1);
    // Movie = single-episode anchor: the selected film maps to S01E01.
    expect(selected[0]?.episodes).toEqual(["S01E01"]);
  });

  it("returns null selection when no candidate is found", async () => {
    const agents = new FakeAgentNodes();
    const result = await agents.planMovieAcquisition({
      title: "无资源电影",
      aliases: [],
      year: 2026,
      qualityPreference: "4K",
      initialKeyword: "无资源电影 4K",
      failureEvidence: [],
      searchResources: async () => snapshot("empty", []),
    });
    expect(result.plan.selectedSnapshotId).toBeNull();
  });
});
