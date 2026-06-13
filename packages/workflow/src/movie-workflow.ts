import { importForeignWorkAsMovie } from "./commands.js";
import {
  createEpisodeStates,
  movieAnchorSeason,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowStatus,
} from "./domain.js";
import { validateMoviePlan } from "./movie-plan-validation.js";
import { buildMovieReport, formatReportPushText } from "./notification-report.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";

const VIDEO_EXTENSION = /\.(mkv|mp4|avi|mov|ts|m2ts|wmv|flv|webm|rmvb|iso)$/i;

function defaultNowIso(): string {
  return new Date().toISOString();
}

export interface MovieWorkflowResult {
  status: WorkflowStatus;
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

/**
 * Movie acquisition (Type 1, one-off — no tracking). Evidence-first: the agent
 * confirms identity (anti-remake) and picks ONE film, then the deterministic
 * harness transfers it to staging and lands the single video under
 * `Movies/Title (Year)/Title (Year).ext`. No seasons, no episode mapping; the
 * movie persists as a single-"episode" anchor so the rest of the product
 * (library, notifications) treats it uniformly.
 */
export async function runMovieAcquisition(input: {
  title: MediaTitle;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  stagingParentDirectoryId: string;
  moviesParentDirectoryId: string;
  now?: () => string;
}): Promise<MovieWorkflowResult> {
  const workflowRunId = input.workflowRunId ?? "run_movie";
  const now = input.now ?? defaultNowIso;
  const auditEvents: AuditEvent[] = [];

  const planning = await input.agents.planMovieAcquisition({
    title: input.title.title,
    aliases: input.title.aliases,
    year: input.title.year,
    qualityPreference: "4K",
    initialKeyword: input.keyword,
    failureEvidence: [],
    searchResources: async ({ keyword }) => input.resourceProvider.search({ keyword }),
  });
  const validated = validateMoviePlan({ plan: planning.plan, snapshots: planning.snapshots });

  const anchor = (storageDirectoryId: string): { season: TrackedSeason; episodes: EpisodeState[] } => {
    const season = movieAnchorSeason({
      titleId: input.title.id,
      qualityPreference: "4K",
      storageDirectoryId,
    });
    return {
      season,
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }),
    };
  };

  const noCoverage = (reasonLine: string): MovieWorkflowResult => {
    const { season, episodes } = anchor("");
    const report = {
      ...buildMovieReport(input.title.title),
      status: "no_coverage" as const,
      lines: [reasonLine],
    };
    const notification: NotificationEvent = {
      id: `notification_${workflowRunId}`,
      workflowRunId,
      kind: "no_coverage",
      title: input.title.title,
      body: formatReportPushText(report),
      createdAt: now(),
      trigger: "user",
      report,
    };
    return {
      status: "no_coverage",
      title: input.title,
      season,
      episodes,
      resourceSnapshots: planning.snapshots,
      transferAttempts: [],
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  };

  if (validated.selectedCandidate === null) {
    auditEvents.push({
      type: "acquisition_no_coverage",
      message: `No covering movie resource for ${input.title.title}`,
    });
    return noCoverage("暂未找到可用资源 · 将持续尝试");
  }

  const stagingDirectoryId = await input.storage.createDirectory({
    name: `staging-${workflowRunId}-movie`,
    parentId: input.stagingParentDirectoryId,
  });
  const attempt = await input.storage.transfer({
    workflowRunId,
    directoryId: stagingDirectoryId,
    candidate: validated.selectedCandidate,
  });

  // A movie is one file: pick the largest non-sample video the transfer landed.
  const tree = await input.storage.listTree({ directoryId: stagingDirectoryId });
  const videos = tree
    .filter((file) => VIDEO_EXTENSION.test(file.path) && !/sample/i.test(file.path))
    .sort((left, right) => right.sizeBytes - left.sizeBytes);

  if (videos.length === 0) {
    auditEvents.push({
      type: "acquisition_pass_incomplete",
      message: `Transfer for ${input.title.title} materialized no video file`,
      data: { stagingDirectoryId, candidateId: validated.selectedCandidate.id },
    });
    const result = noCoverage("资源转存未落地 · 将重试");
    return { ...result, transferAttempts: [attempt] };
  }

  const imported = await importForeignWorkAsMovie({
    storage: input.storage,
    providerFileIds: [videos[0]!.providerFileId],
    movieTitle: input.title.title,
    year: input.title.year,
    moviesParentDirectoryId: input.moviesParentDirectoryId,
  });
  const landedVideos = await input.storage.listVideoFiles(imported.movieDirectoryId);
  const landedUnparsed = await input.storage.listUnparsedVideoFiles(imported.movieDirectoryId);
  const obtained = landedVideos.length + landedUnparsed.length > 0;

  auditEvents.push({
    type: "movie_landed",
    message: `${input.title.title} (${input.title.year}) landed${imported.renamedTo ? ` as ${imported.renamedTo}` : ""}`,
    data: { movieDirectoryId: imported.movieDirectoryId, movedFileIds: imported.movedFileIds },
  });

  const { season, episodes } = anchor(imported.movieDirectoryId);
  const finalEpisodes = episodes.map((episode) => ({ ...episode, obtained }));
  const report = obtained
    ? buildMovieReport(input.title.title)
    : { ...buildMovieReport(input.title.title), status: "no_coverage" as const, lines: ["资源转存未落地 · 将重试"] };
  const notification: NotificationEvent = {
    id: `notification_${workflowRunId}`,
    workflowRunId,
    kind: obtained ? "package_initialized" : "no_coverage",
    title: input.title.title,
    body: formatReportPushText(report),
    createdAt: now(),
    trigger: "user",
    report,
  };

  return {
    status: obtained ? "succeeded" : "no_coverage",
    title: input.title,
    season,
    episodes: finalEpisodes,
    resourceSnapshots: planning.snapshots,
    transferAttempts: [attempt],
    decisions: [],
    notification,
    notifications: [notification],
    auditEvents,
  };
}
