import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  reconcileVerifiedFiles,
  runType3Monitoring,
  type AgentDecision,
  type AgentNodes,
  type MediaTitle,
  type ResourceCandidate,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

function qiaochuFixture() {
  const title: MediaTitle = {
    id: "title_qiaochu",
    tmdbId: 289271,
    type: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    aliases: ["Ashes to Crown"],
  };
  const season: TrackedSeason = {
    id: "season_qiaochu_1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir_qiaochu_s1",
    totalEpisodes: 24,
    latestAiredEpisode: 14,
    latestAiredSource: "metadata",
  };
  return { title, season };
}

describe("runType3Monitoring", () => {
  it("repairs externally deleted episodes and uses fallback when primary transfer does not materialize", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles: VerifiedFile[] = Array.from({ length: 12 }, (_, index) => {
      const episode = `S01E${String(index + 1).padStart(2, "0")}`;
      return {
        id: `file_${episode}`,
        storageDirectoryId: season.storageDirectoryId,
        name: `翘楚.${episode}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: episode,
        providerFileId: `provider_${episode}`,
      };
    });
    const initialEpisodes = reconcileVerifiedFiles({
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      files: [
        ...existingFiles,
        {
          id: "missing_old_13",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E13.mkv",
          sizeBytes: 1,
          episodeCode: "S01E13",
          providerFileId: "old_13",
        },
        {
          id: "missing_old_14",
          storageDirectoryId: season.storageDirectoryId,
          name: "old.S01E14.mkv",
          sizeBytes: 1,
          episodeCode: "S01E14",
          providerFileId: "old_14",
        },
      ],
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "no_target_change",
          providerMessage: "already transferred elsewhere",
          files: [],
        },
        snapshot_1_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_13",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E13.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E13",
              providerFileId: "restored_provider_13",
            },
          ],
        },
        snapshot_1_candidate_3: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "restored_14",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E14.restored.mkv",
              sizeBytes: 5_000_000_000,
              episodeCode: "S01E14",
              providerFileId: "restored_provider_14",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [
          { title: "翘楚 S01E13 primary", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E13 fallback", episodeHints: ["S01E13"] },
          { title: "翘楚 S01E14 fallback", episodeHints: ["S01E14"] },
        ],
      },
    });

    const result = await runType3Monitoring({
      title,
      season,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      resourceProvider,
      storage,
      agents: new PrimaryOnlyAgentNodes(),
    });

    expect(result.status).toBe("succeeded");
    expect(result.transferAttempts.map((attempt) => attempt.status)).toEqual([
      "no_target_change",
      "succeeded",
      "succeeded",
    ]);
    expect(result.obtainedEpisodes).toContain("S01E13");
    expect(result.obtainedEpisodes).toContain("S01E14");
    expect(result.notification.body).toContain("2 episodes restored");
    expect(result.notifications).toEqual([result.notification]);
  });

  it("rejects agent decisions that reference candidates outside the current snapshot", async () => {
    const { title, season } = qiaochuFixture();
    const existingFiles: VerifiedFile[] = [];
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: 1,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: existingFiles },
      transferOutcomes: {
        snapshot_99_candidate_1: {
          status: "succeeded",
          providerMessage: "stale candidate should never transfer",
          files: [
            {
              id: "stale_file_01",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E01.stale.mkv",
              sizeBytes: 1,
              episodeCode: "S01E01",
              providerFileId: "stale_provider_01",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E01 current", episodeHints: ["S01E01"] }],
      },
    });

    await expect(
      runType3Monitoring({
        title,
        season: { ...season, latestAiredEpisode: 1 },
        episodes: initialEpisodes,
        keyword: "翘楚 4K",
        resourceProvider,
        storage,
        agents: new StaleSnapshotAgentNodes(),
      }),
    ).rejects.toThrow("Agent decision referenced a different resource snapshot");

    await expect(storage.listVideoFiles(season.storageDirectoryId)).resolves.toEqual([]);
  });

  it("rejects stale candidate ids hidden in agent decision mappings", async () => {
    const { title, season } = qiaochuFixture();
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: 1,
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "current candidate should not transfer after invalid mapping",
          files: [
            {
              id: "file_01",
              storageDirectoryId: season.storageDirectoryId,
              name: "翘楚.S01E01.mkv",
              sizeBytes: 1,
              episodeCode: "S01E01",
              providerFileId: "provider_01",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E01 current", episodeHints: ["S01E01"] }],
      },
    });

    await expect(
      runType3Monitoring({
        title,
        season: { ...season, latestAiredEpisode: 1 },
        episodes: initialEpisodes,
        keyword: "翘楚 4K",
        resourceProvider,
        storage,
        agents: new StaleMappingAgentNodes(),
      }),
    ).rejects.toThrow("Agent decision referenced candidates outside the current resource snapshot");

    await expect(storage.listVideoFiles(season.storageDirectoryId)).resolves.toEqual([]);
  });

  it("records provider-ahead files without waiting for metadata to catch up", async () => {
    const { title, season } = qiaochuFixture();
    const aheadSeason = { ...season, latestAiredEpisode: 20 };
    const storage = new FakeStorageExecutor({
      directories: { [aheadSeason.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [
            {
              id: "file_20",
              storageDirectoryId: aheadSeason.storageDirectoryId,
              name: "翘楚.S01E20.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E20",
              providerFileId: "provider_20",
            },
            {
              id: "file_21",
              storageDirectoryId: aheadSeason.storageDirectoryId,
              name: "翘楚.S01E21.mkv",
              sizeBytes: 1_000_000_000,
              episodeCode: "S01E21",
              providerFileId: "provider_21",
            },
          ],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "翘楚 4K": [{ title: "翘楚 S01E20-S01E21 4K", episodeHints: ["S01E20", "S01E21"] }],
      },
    });
    const initialEpisodes = createEpisodeStates({
      trackedSeasonId: aheadSeason.id,
      seasonNumber: aheadSeason.seasonNumber,
      totalEpisodes: aheadSeason.totalEpisodes,
      latestAiredEpisode: aheadSeason.latestAiredEpisode,
    });

    const result = await runType3Monitoring({
      title,
      season: aheadSeason,
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.episodes.find((episode) => episode.episodeCode === "S01E21")).toMatchObject({
      obtained: true,
      metadataStatus: "provider_ahead",
    });
    expect(result.providerAheadEpisodes).toEqual(["S01E21"]);
  });

  it("marks an episode obtained without searching when the target directory already has it", async () => {
    const { title, season } = qiaochuFixture();
    const currentFiles: VerifiedFile[] = Array.from({ length: 13 }, (_, index) => {
      const episode = `S01E${String(index + 1).padStart(2, "0")}`;
      return {
        id: `file_${episode}`,
        storageDirectoryId: season.storageDirectoryId,
        name: `翘楚.${episode}.mkv`,
        sizeBytes: 1_000_000_000,
        episodeCode: episode,
        providerFileId: `provider_${episode}`,
      };
    });
    const initialEpisodes = reconcileVerifiedFiles({
      season: { ...season, latestAiredEpisode: 13 },
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: 13,
      }),
      files: currentFiles.slice(0, 12),
    });
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: currentFiles },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordErrors: { "翘楚 4K": "search should not be called" },
      keywordResults: {},
    });

    const result = await runType3Monitoring({
      title,
      season: { ...season, latestAiredEpisode: 13 },
      episodes: initialEpisodes,
      keyword: "翘楚 4K",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.transferAttempts).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.episodes.find((episode) => episode.episodeCode === "S01E13")).toMatchObject({
      obtained: true,
    });
  });
});

class PrimaryOnlyAgentNodes implements AgentNodes {
  async generateKeywords(): Promise<{ keywords: string[]; reason: string }> {
    return {
      keywords: [],
      reason: "not used",
    };
  }

  async selectEpisodeCoverage(input: {
    snapshotId: string;
    candidates: ResourceCandidate[];
    missingEpisodes: string[];
    latestAiredEpisode: number;
  }): Promise<AgentDecision> {
    const primary = input.candidates[0];
    if (!primary) {
      throw new Error("Expected at least one primary candidate");
    }

    return {
      node: "primary_only",
      snapshotId: input.snapshotId,
      selectedCandidateIds: [primary.id],
      episodeMapping: {
        [primary.id]: primary.episodeHints.filter((episodeCode) => input.missingEpisodes.includes(episodeCode)),
      },
      providerAheadEpisodeMapping: {},
      rejectedCandidateIds: input.candidates.slice(1).map((candidate) => candidate.id),
      confidence: "medium",
      reason: `Selected only primary with latest aired ${input.latestAiredEpisode}`,
    };
  }
}

class StaleSnapshotAgentNodes implements AgentNodes {
  async generateKeywords(): Promise<{ keywords: string[]; reason: string }> {
    return {
      keywords: [],
      reason: "not used",
    };
  }

  async selectEpisodeCoverage(): Promise<AgentDecision> {
    return {
      node: "stale_snapshot",
      snapshotId: "snapshot_99",
      selectedCandidateIds: ["snapshot_99_candidate_1"],
      episodeMapping: {
        snapshot_99_candidate_1: ["S01E01"],
      },
      providerAheadEpisodeMapping: {},
      rejectedCandidateIds: [],
      confidence: "high",
      reason: "stale decision from a previous search",
    };
  }
}

class StaleMappingAgentNodes implements AgentNodes {
  async generateKeywords(): Promise<{ keywords: string[]; reason: string }> {
    return {
      keywords: [],
      reason: "not used",
    };
  }

  async selectEpisodeCoverage(input: {
    snapshotId: string;
    candidates: ResourceCandidate[];
  }): Promise<AgentDecision> {
    const current = input.candidates[0];
    if (!current) {
      throw new Error("Expected at least one current candidate");
    }

    return {
      node: "stale_mapping",
      snapshotId: input.snapshotId,
      selectedCandidateIds: [current.id],
      episodeMapping: {
        [current.id]: ["S01E01"],
        snapshot_99_candidate_1: ["S01E01"],
      },
      providerAheadEpisodeMapping: {
        snapshot_99_candidate_1: ["S01E99"],
      },
      rejectedCandidateIds: ["snapshot_99_candidate_2"],
      confidence: "high",
      reason: "selected current candidate but leaked stale ids in mappings",
    };
  }
}
