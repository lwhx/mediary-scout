import {
  createEpisodeStates,
  episodeNumberFromCode,
  getTrackedSeasonStatusView,
  InMemoryWorkflowRepository,
  type EpisodeState,
  type MediaTitle,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type WorkflowRepository,
  type WorkflowRun,
} from "@media-track/workflow";

export interface DashboardState {
  trackedSeason: TrackedSeasonStatusView;
  events: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
  }>;
}

export async function getDashboardState(): Promise<DashboardState> {
  const repository = await createDemoWorkflowRepository();
  const { season } = qiaochuFixture();

  const trackedSeason = await getTrackedSeasonStatusView({
    repository,
    trackedSeasonId: season.id,
  });
  if (!trackedSeason) {
    throw new Error("Demo tracked season was not created");
  }

  return dashboardStateFromTrackedSeason(trackedSeason);
}

export async function createDemoWorkflowRepository(): Promise<InMemoryWorkflowRepository> {
  const repository = new InMemoryWorkflowRepository();
  await seedDemoWorkflowRepository(repository);
  return repository;
}

const DEMO_ACCOUNT = "acct_default";
const DEMO_DRIVE_115 = "cs_demo_115";
const DEMO_DRIVE_QUARK = "cs_demo_quark";

export async function seedDemoWorkflowRepository(repository: WorkflowRepository): Promise<void> {
  // Two drives → the workspace switcher (≥2) + brand icons + per-drive scoping all
  // show in the demo. Provisioned cids set so they read as healthy/active.
  await repository.upsertConnectedStorage({
    id: DEMO_DRIVE_115,
    accountId: DEMO_ACCOUNT,
    provider: "pan115",
    providerUid: "demo115",
    label: null,
    payload: { meta: { connectedAt: "2026-06-01T00:00:00.000Z" } },
    rootCid: "demo_root_115",
    moviesCid: "demo_movies_115",
    tvCid: "demo_tv_115",
    animeCid: "demo_anime_115",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  await repository.upsertConnectedStorage({
    id: DEMO_DRIVE_QUARK,
    accountId: DEMO_ACCOUNT,
    provider: "quark",
    providerUid: "demoquark",
    label: null,
    payload: { meta: { connectedAt: "2026-06-05T00:00:00.000Z" } },
    rootCid: "demo_root_q",
    moviesCid: "demo_movies_q",
    tvCid: "demo_tv_q",
    animeCid: "demo_anime_q",
    createdAt: "2026-06-05T00:00:00.000Z",
  });

  // Tracked show on the primary (115) drive — partial + airing → 缺集 + 追更 badges.
  const { title, season } = qiaochuFixture();
  await repository.saveWorkflowRunSnapshot({
    accountId: DEMO_ACCOUNT,
    connectedStorageId: DEMO_DRIVE_115,
    title,
    season,
    workflowRun: workflowRun(season),
    episodes: seedEpisodes(season),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [
      {
        id: "demo_notif_qiaochu",
        workflowRunId: "run_demo_qiaochu",
        kind: "tracking_initialized",
        title: "翘楚 第 1 季 · 已获取 12 集",
        body: "已获取至第 12 集，剩余将由每日巡检自动补齐。",
        createdAt: "2026-06-11T00:02:00.000Z",
      },
    ],
  });

  // Two completed movies, one on each drive.
  const truman = movieFixture({ tmdbId: 37165, title: "楚门的世界", year: 1998, storageDirectoryId: "demo_movies_115" });
  await repository.saveWorkflowRunSnapshot({
    accountId: DEMO_ACCOUNT,
    connectedStorageId: DEMO_DRIVE_115,
    title: truman.title,
    season: truman.season,
    workflowRun: movieRun("run_demo_truman", truman.season.id),
    episodes: truman.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [
      {
        id: "demo_notif_truman",
        workflowRunId: "run_demo_truman",
        kind: "movie_obtained",
        title: "楚门的世界 (1998) · 已入库",
        body: "已转存到 115 网盘并完成验证。",
        createdAt: "2026-06-12T08:00:00.000Z",
      },
    ],
  });

  const shawshank = movieFixture({ tmdbId: 278, title: "肖申克的救赎", year: 1994, storageDirectoryId: "demo_movies_q" });
  await repository.saveWorkflowRunSnapshot({
    accountId: DEMO_ACCOUNT,
    connectedStorageId: DEMO_DRIVE_QUARK,
    title: shawshank.title,
    season: shawshank.season,
    workflowRun: movieRun("run_demo_shawshank", shawshank.season.id),
    episodes: shawshank.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

function movieFixture(input: {
  tmdbId: number;
  title: string;
  year: number;
  storageDirectoryId: string;
}): { title: MediaTitle; season: TrackedSeason; episodes: EpisodeState[] } {
  const title: MediaTitle = {
    id: `tmdb_movie_${input.tmdbId}`,
    tmdbId: input.tmdbId,
    type: "movie",
    title: input.title,
    originalTitle: input.title,
    year: input.year,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: `tmdb_movie_${input.tmdbId}_movie`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: input.storageDirectoryId,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
  }).map((episode) => ({ ...episode, obtained: true, verifiedFileIds: [`file_movie_${input.tmdbId}`] }));
  return { title, season, episodes };
}

function movieRun(id: string, trackedSeasonId: string): WorkflowRun {
  return {
    id,
    kind: "movie_init",
    status: "succeeded",
    trackedSeasonId,
    startedAt: "2026-06-12T07:58:00.000Z",
    finishedAt: "2026-06-12T08:00:00.000Z",
    auditEvents: [],
  };
}

export function dashboardStateFromTrackedSeason(trackedSeason: TrackedSeasonStatusView): DashboardState {
  return {
    trackedSeason,
    events: [
      {
        id: "demo_event_obtained",
        kind: "tracking_initialized",
        title: "翘楚 S01E01-S01E12 已获取",
        body: "目标目录已验证到 12 个视频文件。",
      },
      {
        id: "demo_event_missing",
        kind: "no_coverage",
        title: "S01E13-S01E14 等待修复",
        body: "已播出但未获取，会进入后续 Type 3 检查。",
      },
      {
        id: "demo_event_health",
        kind: "already_current",
        title: "115 连接有效",
        body: "最近一次最小读验证通过。",
      },
    ],
  };
}

function qiaochuFixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "tmdb_tv_289271",
    tmdbId: 289271,
    type: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    aliases: [],
  };
  return {
    title,
    season: {
      id: "tmdb_tv_289271_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "115_dir_qiaochu_s1",
      totalEpisodes: 24,
      latestAiredEpisode: 14,
      latestAiredSource: "metadata",
    },
  };
}

function seedEpisodes(season: TrackedSeason): EpisodeState[] {
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  }).map((episode) => {
    // Use the canonical parser, not slice(-2): the latter silently breaks for
    // episodes >= 100 ("S01E100".slice(-2) === "00").
    const episodeNumber = episodeNumberFromCode(episode.episodeCode);
    if (episodeNumber <= 12) {
      return {
        ...episode,
        obtained: true,
        verifiedFileIds: [`file_${episode.episodeCode}`],
      };
    }
    return episode;
  });
}

function workflowRun(season: TrackedSeason): WorkflowRun {
  return {
    id: "run_demo_qiaochu",
    kind: "type2_init",
    status: "succeeded",
    trackedSeasonId: season.id,
    startedAt: "2026-06-11T00:00:00.000Z",
    finishedAt: "2026-06-11T00:02:00.000Z",
    auditEvents: [],
  };
}
