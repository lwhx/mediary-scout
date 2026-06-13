import { describe, expect, it } from "vitest";
import { validateMoviePlan, type AcquisitionPlan, type ResourceSnapshot } from "../src/index.js";

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

function plan(over: Partial<AcquisitionPlan>): AcquisitionPlan {
  return {
    node: "test",
    selectedSnapshotId: null,
    searchedKeywords: [],
    candidateDispositions: [],
    confidence: "high",
    reason: "",
    ...over,
  };
}

describe("validateMoviePlan", () => {
  it("returns the single selected candidate", () => {
    const snap = snapshot("s", ["奥本海默 4K", "奥本海默 1080p"]);
    const result = validateMoviePlan({
      plan: plan({
        selectedSnapshotId: "s",
        candidateDispositions: [
          { candidateId: "s_c1", disposition: "selected", episodes: ["S01E01"], reason: "best" },
          { candidateId: "s_c2", disposition: "rejected", episodes: [], reason: "lower quality" },
        ],
      }),
      snapshots: [snap],
    });
    expect(result.selectedCandidate?.id).toBe("s_c1");
  });

  it("returns null selection for an honest no-coverage plan", () => {
    const result = validateMoviePlan({ plan: plan({ selectedSnapshotId: null }), snapshots: [snapshot("s", [])] });
    expect(result.selectedSnapshot).toBeNull();
    expect(result.selectedCandidate).toBeNull();
  });

  it("rejects more than one selected candidate (a movie is a single file)", () => {
    const snap = snapshot("s", ["a", "b"]);
    expect(() =>
      validateMoviePlan({
        plan: plan({
          selectedSnapshotId: "s",
          candidateDispositions: [
            { candidateId: "s_c1", disposition: "selected", episodes: ["S01E01"], reason: "" },
            { candidateId: "s_c2", disposition: "selected", episodes: ["S01E01"], reason: "" },
          ],
        }),
        snapshots: [snap],
      }),
    ).toThrow(/at most one/);
  });

  it("rejects a candidate that was not observed in this run", () => {
    expect(() =>
      validateMoviePlan({
        plan: plan({
          selectedSnapshotId: "s",
          candidateDispositions: [{ candidateId: "ghost", disposition: "selected", episodes: ["S01E01"], reason: "" }],
        }),
        snapshots: [snapshot("s", ["a"])],
      }),
    ).toThrow(/not observed/);
  });
});
