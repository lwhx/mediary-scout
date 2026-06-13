import { describe, expect, it } from "vitest";
import {
  FakeAgentNodes,
  FakeResourceProvider,
  runAcquisitionPlanningSmoke,
  type AgentNodes,
} from "../src/index.js";

const smokeTarget = {
  title: "翘楚",
  aliases: ["Ashes to Crown"],
  seasonNumber: 1,
  qualityPreference: "4K",
  missingEpisodes: ["S01E15"],
  latestAiredEpisode: 14,
  initialKeyword: "翘楚 4K",
};

describe("runAcquisitionPlanningSmoke", () => {
  it("reports plan_valid with selected candidate titles for a covering plan", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E15 4K", episodeHints: ["S01E15"] }],
      },
    });

    const result = await runAcquisitionPlanningSmoke({
      ...smokeTarget,
      agents: new FakeAgentNodes(),
      resourceProvider: provider,
    });

    expect(result.status).toBe("plan_valid");
    expect(result.selectedCandidateTitles).toEqual(["翘楚 S01E15 4K"]);
    expect(result.snapshots[0]).toMatchObject({ keyword: "翘楚 4K", candidateCount: 1 });
    expect(result.validationError).toBeNull();
    expect(result.agentError).toBeNull();
  });

  it("reports agent_error when the planning agent itself fails", async () => {
    const agents = {
      planAcquisition: async () => {
        throw new Error("model endpoint rejected the request");
      },
      recognizePackage: async () => {
        throw new Error("unused");
      },
      planMovieAcquisition: async () => {
        throw new Error("unused");
      },
      selectMovieMasterFile: async () => {
        throw new Error("unused");
      },
    } satisfies AgentNodes;

    const result = await runAcquisitionPlanningSmoke({
      ...smokeTarget,
      agents,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
    });

    expect(result.status).toBe("agent_error");
    expect(result.agentError).toContain("model endpoint rejected");
    expect(result.plan).toBeNull();
  });

  it("reports plan_invalid with the validation message for a contract-violating plan", async () => {
    const provider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E15 4K", episodeHints: ["S01E15"] },
          { title: "翘楚 S01E15 备用", episodeHints: ["S01E15"] },
        ],
      },
    });
    const agents = {
      planAcquisition: async (input: Parameters<AgentNodes["planAcquisition"]>[0]) => {
        const snapshot = await input.searchResources({ keyword: input.initialKeyword });
        const first = snapshot.candidates[0]!;
        return {
          plan: {
            node: "truncating_agent",
            selectedSnapshotId: snapshot.id,
            searchedKeywords: [input.initialKeyword],
            candidateDispositions: [
              {
                candidateId: first.id,
                disposition: "selected" as const,
                episodes: [...first.episodeHints],
                reason: "Ignored the second candidate.",
              },
            ],
            confidence: "high" as const,
            reason: "Truncated judgment.",
          },
          snapshots: [snapshot],
          trace: [],
        };
      },
      recognizePackage: async () => {
        throw new Error("unused");
      },
      planMovieAcquisition: async () => {
        throw new Error("unused");
      },
      selectMovieMasterFile: async () => {
        throw new Error("unused");
      },
    } satisfies AgentNodes;

    const result = await runAcquisitionPlanningSmoke({
      ...smokeTarget,
      agents,
      resourceProvider: provider,
    });

    expect(result.status).toBe("plan_invalid");
    expect(result.validationError).toMatch(/every candidate/);
    expect(result.selectedCandidateTitles).toEqual([]);
  });
});
