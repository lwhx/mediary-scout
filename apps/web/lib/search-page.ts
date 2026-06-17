import {
  createTmdbSearchProvider,
  getSearchPageView,
  InMemoryMediaSearchCache,
  type MediaSearchProvider,
  type SearchPageView,
} from "@media-track/workflow";
import { dashboardStateFromTrackedSeason, type DashboardState } from "./demo-workflow";
import { demoMediaSearchProvider } from "./demo-candidates";
import { PostgresMediaSearchCache } from "./tmdb-cache";
import {
  ensureDemoSeeded,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  getWorkflowStatusView,
  postgresConnectionString,
} from "./workflow-runtime";

export interface ProductPageData {
  search: SearchPageView;
  dashboard: DashboardState;
}

let demoSearchCache: InMemoryMediaSearchCache | null = null;
let durableSearchCache: PostgresMediaSearchCache | null = null;
let tmdbSearchProvider: MediaSearchProvider | null = null;

export async function getProductPageData(query: string): Promise<ProductPageData> {
  const [search, dashboard] = await Promise.all([getSearchView(query), getLibraryDashboard()]);

  return {
    search,
    dashboard,
  };
}

export async function getSearchView(query: string): Promise<SearchPageView> {
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  return getSearchPageView({
    query,
    provider: await getMediaSearchProvider(),
    cache: getSearchCache(),
    repository,
  });
}

export interface LibrarySeasonSummary {
  trackedSeasonId: string;
  seasonNumber: number;
  status: string;
  obtainedCount: number;
  latestAiredEpisode: number;
  totalEpisodes: number;
}

export interface LibraryTitleSummary {
  titleId: string;
  tmdbId: number;
  title: string;
  year: number;
  seasons: LibrarySeasonSummary[];
}

export interface LibraryDashboard extends DashboardState {
  libraryTitles: LibraryTitleSummary[];
}

export async function getLibraryDashboard(): Promise<LibraryDashboard> {
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();
  await ensureDemoSeeded(repository);
  const trackedSeason = await getWorkflowStatusView(repository, accountId);
  if (!trackedSeason) {
    throw new Error("No tracked seasons are available");
  }
  const states = await repository.listTrackedSeasonStates(accountId);
  const byTitle = new Map<string, LibraryTitleSummary>();
  for (const state of states) {
    const entry = byTitle.get(state.title.id) ?? {
      titleId: state.title.id,
      tmdbId: state.title.tmdbId,
      title: state.title.title,
      year: state.title.year,
      seasons: [],
    };
    entry.seasons.push({
      trackedSeasonId: state.season.id,
      seasonNumber: state.season.seasonNumber,
      status: state.season.status,
      obtainedCount: state.episodes.filter((episode) => episode.obtained).length,
      latestAiredEpisode: state.season.latestAiredEpisode,
      totalEpisodes: state.season.totalEpisodes,
    });
    byTitle.set(state.title.id, entry);
  }
  const libraryTitles = [...byTitle.values()].map((title) => ({
    ...title,
    seasons: [...title.seasons].sort((a, b) => a.seasonNumber - b.seasonNumber),
  }));
  // The notice panel shows the real notification feed, not demo copy.
  const notifications = await repository.listNotifications({ limit: 3, accountId });
  const dashboard = dashboardStateFromTrackedSeason(trackedSeason);
  if (notifications.length > 0) {
    dashboard.events = notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
    }));
  }
  return { ...dashboard, libraryTitles };
}

function getSearchCache() {
  // Live TMDB searches are cached durably in SQLite (6h TTL) so casual
  // browsing never becomes an API storm; the demo provider stays in-memory.
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    durableSearchCache ??= new PostgresMediaSearchCache({ connectionString: postgresConnectionString() });
    return durableSearchCache;
  }
  demoSearchCache ??= new InMemoryMediaSearchCache();
  return demoSearchCache;
}

async function getMediaSearchProvider(): Promise<MediaSearchProvider> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return demoMediaSearchProvider;
  }
  tmdbSearchProvider ??= createTmdbSearchProvider(await getTmdbAccesses(getWorkflowRepository()));
  return tmdbSearchProvider;
}
