import type { LanguageModel } from "ai";
import type { ResourceProvider, StorageExecutor } from "../ports.js";
import { ensureSeasonAcquisitionDirectories, type AcquisitionDirectories } from "./directory-lifecycle.js";
import type { DeadLinkStore } from "./dead-links.js";
import { runAcquisitionV2, type AcquisitionV2Outcome } from "./orchestrator.js";
import { syncSeasonNeed } from "./sync-need.js";

/**
 * Phase 7c — the outer workflow orchestration (TV/anime). It is the same
 * resource-sync shape for every situation (init / ongoing / patrol): ensure the
 * directory tree (verify-or-create), sync the need (应有 vs 实有 → cross-season
 * missing), run the strong agent over the sandbox if anything is missing, then
 * reconcile by re-reading storage. Returns facts; persistence/notification is the
 * caller's (runner's) job. No live side effects beyond the injected executor.
 */
export interface V2WorkflowSeason {
  seasonNumber: number;
  /** Aired up to this episode (should-exist = E01..latestAiredEpisode). */
  latestAiredEpisode: number;
}

export interface RunAcquisitionV2WorkflowRequest {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  title: { name: string; year: number; aliases: string[] };
  /** Library category parent (Movies/TV/Anime), chosen by title.type upstream. */
  categoryParentId: string;
  seasons: V2WorkflowSeason[];
  qualityPreference: string;
  /** 实有 = the DB obtained marks for this title (the agent's prior markObtained).
   *  Empty for a first acquisition; the type-3 patrol passes the DB's obtained
   *  episode codes so the need = aired − 实有 (NOT a 115 scan). */
  priorObtained?: string[];
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  searchHints?: string;
  deadLinkStore?: DeadLinkStore;
}

export interface RunAcquisitionV2WorkflowResult {
  directories: AcquisitionDirectories;
  /** The missing set computed before the agent ran. */
  missingBefore: string[];
  outcome: AcquisitionV2Outcome;
  agentText: string;
  /** Re-synced from real storage after the agent: what is still missing / obtained. */
  stillMissing: string[];
  obtained: string[];
  providerAhead: string[];
}

const EMPTY_OUTCOME: AcquisitionV2Outcome = { resourceSnapshots: [], decisions: [], transferAttempts: [] };

export async function runAcquisitionV2Workflow(
  request: RunAcquisitionV2WorkflowRequest,
): Promise<RunAcquisitionV2WorkflowResult> {
  // 7a — verify-or-create the directory tree, get scoped handles.
  const directories = await ensureSeasonAcquisitionDirectories({
    executor: request.executor,
    categoryParentId: request.categoryParentId,
    showName: request.title.name,
    year: request.title.year,
    seasons: request.seasons.map((season) => season.seasonNumber),
    workflowRunId: request.workflowRunId,
  });
  const seasonsForSync = request.seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    latestAiredEpisode: season.latestAiredEpisode,
  }));
  const priorObtained = request.priorObtained ?? [];

  // 7b — sync the need from the DB marks (应有 − 实有). No 115 scan, no parser.
  const before = syncSeasonNeed({ seasons: seasonsForSync, obtained: priorObtained });
  if (before.missing.length === 0) {
    // Already current — no agent run, no side effects (the type-3 no-op path).
    return {
      directories,
      missingBefore: [],
      outcome: EMPTY_OUTCOME,
      agentText: "",
      stillMissing: [],
      obtained: before.obtained,
      providerAhead: before.providerAhead,
    };
  }

  // Run the strong TV/anime agent over the sandbox.
  const v2 = await runAcquisitionV2({
    provider: request.provider,
    executor: request.executor,
    model: request.model,
    workflowRunId: request.workflowRunId,
    target: {
      kind: "tv",
      title: request.title.name,
      aliases: request.title.aliases,
      seasons: request.seasons.map((season) => season.seasonNumber),
      missingEpisodes: before.missing,
      qualityPreference: request.qualityPreference,
    },
    stagingDirectoryId: directories.stagingDirectoryId,
    targetSeasonDirectoryIds: directories.seasonDirectoryIds,
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    ...(request.searchHints === undefined ? {} : { searchHints: request.searchHints }),
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
  });

  // Reconcile from the AGENT'S coverage (its markObtained), NOT a 115 re-scan:
  // 实有 after = prior DB marks ∪ what the agent marked this run (§1.13/§7b).
  const after = syncSeasonNeed({
    seasons: seasonsForSync,
    obtained: [...priorObtained, ...v2.coverage.obtained],
  });
  return {
    directories,
    missingBefore: before.missing,
    outcome: v2.outcome,
    agentText: v2.text,
    stillMissing: after.missing,
    obtained: after.obtained,
    providerAhead: after.providerAhead,
  };
}
