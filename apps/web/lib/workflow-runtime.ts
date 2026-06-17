import { randomBytes } from "node:crypto";
import {
  PanSouResourceProvider,
  createProtectedPan115CookieStorageExecutorFromEnv,
  CompositeResourceProvider,
  ProwlarrResourceProvider,
  createTmdbMetadataProvider,
  TMDB_DIRECT_BASE_URL,
  type TmdbAccess,
  episodeCode,
  FakeResourceProvider,
  FakeStorageExecutor,
  createNotifyChannelsFromEnv,
  createAgentModel,
  createAgentModelFromEnv,
  createStubAcquisitionModel,
  dispatchNotifications,
  formatDailyDigestPushText,
  getTrackedSeasonStatusView,
  importForeignWorkAsMovie,
  assertWorkflowAgentAdapterPolicy,
  prepareMovieTarget,
  prepareSeriesTarget,
  prepareTrackingTarget,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reserveMovie,
  runQueuedMovieAcquisition,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  runScheduledType3Monitoring,
  sendPushNotifications,
  createPostgresWorkflowRepositorySync,
  migrateLegacyCookieToDefaultAccount,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  isSessionExpired,
  generateSessionId,
  DuplicateUsernameError,
  DEFAULT_ACCOUNT_ID,
  type Account,
  type MediaSearchCandidate,
  type MediaTitle,
  type NotificationEvent,
  type ResourceProvider,
  type SeasonMetadataSync,
  type StorageExecutor,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type VerifiedFile,
  type WorkflowRepository,
} from "@media-track/workflow";
import { findDemoCandidateById, findDemoCandidateByTmdbId } from "./demo-candidates";
import { seedDemoWorkflowRepository } from "./demo-workflow";

export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

let repository: WorkflowRepository | null = null;
let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
let agentModel:
  | { signature: string; model: ReturnType<typeof createAgentModelFromEnv> }
  | null = null;

/** The Postgres connection string for durable dev/prod state. SQLite has been
 *  retired — dev runs on OrbStack Postgres. */
export function postgresConnectionString(): string {
  const url = process.env.MEDIA_TRACK_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error("MEDIA_TRACK_POSTGRES_URL is required (the SQLite dev DB has been retired)");
  }
  return url;
}

export function getWorkflowRepository(): WorkflowRepository {
  if (!repository) {
    repository = createPostgresWorkflowRepositorySync({ connectionString: postgresConnectionString() });
  }
  return repository;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AuthOutcome =
  | { ok: true; accountId: string; signedCookie: string }
  | { ok: false; error: string };

/** Create a session row + signed httpOnly cookie value for an account. */
async function createLoginSession(accountId: string): Promise<string> {
  const repository = getWorkflowRepository();
  const sessionId = generateSessionId();
  const nowMs = Date.now();
  await repository.createSession({
    id: sessionId,
    accountId,
    expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
  });
  return signSession(sessionId, await getSessionSecret());
}

/**
 * Register a local account (multi-user). v1: open registration (self-host — the
 * operator controls who can reach the instance; login exists to separate data,
 * not to defend a public endpoint). The first account created is the owner, for
 * future group/admin features. Returns a signed session cookie (auto-login).
 */
export async function registerAccount(username: string, password: string): Promise<AuthOutcome> {
  const trimmed = username.trim();
  if (trimmed.length < 2 || password.length < 6) {
    return { ok: false, error: "用户名至少 2 位、密码至少 6 位。" };
  }
  const repository = getWorkflowRepository();
  const isFirst = (await repository.listAccounts()).every((account) => account.id === DEFAULT_ACCOUNT_ID);
  const account: Account = {
    id: `acct_${randomBytes(12).toString("hex")}`,
    username: trimmed,
    passwordHash: await hashPassword(password),
    groupId: null,
    isOwner: isFirst,
    createdAt: new Date().toISOString(),
  };
  try {
    await repository.createAccount(account);
  } catch (error) {
    if (error instanceof DuplicateUsernameError) {
      return { ok: false, error: "用户名已存在。" };
    }
    throw error;
  }
  return { ok: true, accountId: account.id, signedCookie: await createLoginSession(account.id) };
}

/** Authenticate username+password and start a session. */
export async function loginAccount(username: string, password: string): Promise<AuthOutcome> {
  const account = await getWorkflowRepository().getAccountByUsername(username.trim());
  // Verify even when the account is missing-ish to avoid trivial username probing
  // (the empty-hash default account has no password and can't be logged into).
  const hash = account?.passwordHash ?? "";
  const valid = hash.length > 0 && (await verifyPassword(password, hash));
  if (!account || !valid) {
    return { ok: false, error: "用户名或密码不正确。" };
  }
  return { ok: true, accountId: account.id, signedCookie: await createLoginSession(account.id) };
}

/** Destroy the session behind a signed cookie (logout). Best-effort. */
export async function logoutSession(signedCookie: string | undefined): Promise<void> {
  if (!signedCookie) {
    return;
  }
  const sessionId = verifySession(signedCookie, await getSessionSecret());
  if (sessionId) {
    await getWorkflowRepository().deleteSession(sessionId);
  }
}

/** §7 P1: multi-user mode gates the login/register UI + session enforcement.
 *  Default OFF → single-user, no login, everything is the implicit default
 *  account (P0 behavior, zero-change). */
export function isMultiUserEnabled(): boolean {
  return process.env.MEDIA_TRACK_MULTI_USER === "1";
}

export const SESSION_COOKIE_NAME = "mt_session";
const SESSION_SECRET_SETTING_KEY = "session_secret";
/** Sentinel account that owns no data — returned in multi-user mode when there
 *  is no valid session, so reads fail CLOSED (empty) instead of leaking the
 *  default account's data to an unauthenticated caller. Middleware normally
 *  redirects first; this is defense-in-depth. */
export const UNAUTHENTICATED_ACCOUNT_ID = "acct_unauthenticated";

let sessionSecretCache: string | null = null;

/** The HMAC secret for session cookies: env override, else a generated value
 *  persisted in global app_settings (self-host: stable across restarts, the
 *  operator needn't manage it). */
export async function getSessionSecret(): Promise<string> {
  if (sessionSecretCache) {
    return sessionSecretCache;
  }
  const envSecret = process.env.MEDIA_TRACK_SESSION_SECRET?.trim();
  if (envSecret) {
    sessionSecretCache = envSecret;
    return envSecret;
  }
  const repository = getWorkflowRepository();
  const stored = (await repository.getSetting(SESSION_SECRET_SETTING_KEY))?.trim();
  if (stored) {
    sessionSecretCache = stored;
    return stored;
  }
  const generated = randomBytes(32).toString("hex");
  await repository.setSetting(SESSION_SECRET_SETTING_KEY, generated);
  sessionSecretCache = generated;
  return generated;
}

/** Resolve a signed session cookie value to its account id, or null if the
 *  signature is bad, the session is unknown, or it has expired. */
export async function resolveSessionAccountId(signedCookie: string): Promise<string | null> {
  const secret = await getSessionSecret();
  const sessionId = verifySession(signedCookie, secret);
  if (!sessionId) {
    return null;
  }
  const session = await getWorkflowRepository().getSession(sessionId);
  if (!session || isSessionExpired(session.expiresAt, new Date().toISOString())) {
    return null;
  }
  return session.accountId;
}

/**
 * The account whose data the current context operates on. Single-user (multi-user
 * disabled) → the implicit default account, with no cookie access (so the worker
 * and non-request contexts are safe). Multi-user → resolve the signed session
 * cookie in a request context; absent/invalid session falls back to the
 * no-data sentinel (fail-closed; middleware redirects to /login first).
 */
export async function getCurrentAccountId(): Promise<string> {
  if (!isMultiUserEnabled()) {
    return DEFAULT_ACCOUNT_ID;
  }
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const raw = store.get(SESSION_COOKIE_NAME)?.value;
    if (!raw) {
      return UNAUTHENTICATED_ACCOUNT_ID;
    }
    return (await resolveSessionAccountId(raw)) ?? UNAUTHENTICATED_ACCOUNT_ID;
  } catch {
    // No request scope (the in-process worker) — it resolves credentials per
    // claimed run.accountId, not via the request cookie.
    return DEFAULT_ACCOUNT_ID;
  }
}

export async function ensureDemoSeeded(targetRepository: WorkflowRepository): Promise<void> {
  if (process.env.MEDIA_TRACK_DEMO_SEED === "0") {
    return;
  }
  demoSeedPromise ??= seedDemoIfEmpty(targetRepository);
  await demoSeedPromise;
}

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
  accountId?: string,
): Promise<TrackedSeasonStatusView | null> {
  const resolvedAccountId = accountId ?? (await getCurrentAccountId());
  const trackedStates = await targetRepository.listTrackedSeasonStates(resolvedAccountId);
  // The spotlight is the season that still needs attention: prefer an
  // actively-airing season over completed ones.
  const firstTracked =
    trackedStates.find((state) => state.season.status === "active") ?? trackedStates[0];
  if (!firstTracked) {
    return null;
  }
  return getTrackedSeasonStatusView({
    repository: targetRepository,
    trackedSeasonId: firstTracked.season.id,
    accountId: resolvedAccountId,
  });
}

export async function queueCandidateTracking(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId !== null) {
    const movie = await movieTargetFromTmdbId(movieTmdbId);
    if (!movie) {
      return { status: "unsupported", message: "无法获取该电影的信息。" };
    }
    const request = await queueMovieAcquisition({
      title: movie.title,
      keyword: movie.keyword,
      repository: getWorkflowRepository(),
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${movie.title.id}_movie`,
    };
  }

  const target = await trackingTargetFromCandidateId(candidateId);
  if (!target) {
    return {
      status: "unsupported",
      message: "暂时只支持剧集第 1 季的后台获取。",
    };
  }

  const request = await queueTrackingInitialization({
    title: target.title,
    season: target.season,
    keyword: target.keyword,
    repository: getWorkflowRepository(),
  });
  const status = request.status === "completed" ? "queued" : request.status;

  return {
    status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: request.trackedSeasonId,
  };
}

/**
 * Crash recovery for the single-instance in-process worker: any run still
 * "running" when the server (re)starts is orphaned by a dead worker (only this
 * process executes runs), so requeue it to be claimed again. Returns the count.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  return getWorkflowRepository().requeueRunningWorkflowRuns();
}

/**
 * §7 P0 startup migration (idempotent): move a pre-multi-account deployment's
 * single global 115 cookie into a `connected_storages` row owned by the implicit
 * default account, with CIDs from the env the worker used to read. Single-user
 * deployments see no behavior change — the worker resolves the same cookie, just
 * from the per-account connection record. Best-effort; logged, never throws.
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    const result = await migrateLegacyCookieToDefaultAccount({
      repository: getWorkflowRepository(),
      env: process.env,
      now: new Date().toISOString(),
    });
    if (result.migrated) {
      console.log(
        `[media-track] migrated legacy 115 cookie → ${DEFAULT_ACCOUNT_ID} connected_storage (uid ${result.providerUid})`,
      );
    }
  } catch (error) {
    console.error(`[media-track] startup migration failed: ${String(error)}`);
  }
}

export async function runNextQueuedWorkflow() {
  const repository = getWorkflowRepository();
  // §7 P0: single-instance worker, single (default) account. P1 multi-account
  // restructures this to claim-first then resolve the claimed run's account; for
  // now the queue is one account's, so resolve its credentials up front.
  const accountId = await getCurrentAccountId();
  await hydratePan115CookieFromDb();
  // The user's language preference is standing context baked into the agent
  // instance (one global preference), so every workflow — movie, series, type2,
  // anime — searches with it. No per-workflow plumbing.
  const { model, preferredLanguage, qualityPreference } = await getAgentModel(repository);
  const language = preferredLanguage === undefined ? {} : { preferredLanguage };
  const quality = qualityPreference === undefined ? {} : { qualityPreference };
  const storage = await getWorkerStorageExecutor(accountId);
  const parents = await getWorkerStorageParents(accountId);
  const startedAt = new Date().toISOString();
  const type2 = await runQueuedType2Workflow({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
  });
  if (type2.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return type2;
  }
  const series = await runQueuedSeriesInitialization({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: parents.tv,
    animeStorageParentDirectoryId: parents.anime,
  });
  if (series.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return series;
  }
  const movie = await runQueuedMovieAcquisition({
    repository,
    resourceProvider: await getWorkerResourceProvider(),
    storage,
    model,
    ...language,
    ...quality,
    moviesParentDirectoryId: parents.movies,
  });
  if (movie.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
  }
  return movie;
}

/** The user's preferred subtitle language for acquisition search, or undefined
 *  when unset / "any" (agent searches broadly). */
export async function getPreferredLanguage(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string | undefined> {
  const value = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY))?.trim();
  // Explicit "不限" → no preference. Unset → the product default the Settings UI
  // shows as selected ("中文（默认）"), so a fresh install actually prefers Chinese
  // subtitles instead of silently searching broadly.
  if (value === "any") {
    return undefined;
  }
  return value || "中文";
}

export const PREFERRED_LANGUAGE_SETTING_KEY = "preferred_language";

export const QUALITY_PREFERENCE_SETTING_KEY = "quality_preference";

/** The user's acquisition quality preference, or undefined when 不限/unset
 *  (the default). undefined → inject NO quality guidance (coverage-only, current
 *  behavior). Only "high"/"medium" are honored; anything else (incl. the legacy
 *  "4K" value) is treated as 不限. */
export async function getQualityPreference(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<"high" | "medium" | undefined> {
  const value = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY))?.trim();
  return value === "high" || value === "medium" ? value : undefined;
}

// AI 模型 (LLM) 三件套 — OpenAI-compatible. Stored in the user's OWN app_settings
// (self-host, BYO-key: the operator never sees these). DB overrides .env.
export const LLM_BASE_URL_SETTING_KEY = "llm_base_url";
export const LLM_API_KEY_SETTING_KEY = "llm_api_key";
export const LLM_MODEL_ID_SETTING_KEY = "llm_model_id";

/** The user's configured OpenAI-compatible LLM (Settings → AI 模型). Each field is
 *  undefined when unset/blank, so `getAgentModel` cleanly falls back to .env. */
export async function getLlmConfig(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{ baseURL: string | undefined; apiKey: string | undefined; modelId: string | undefined }> {
  const read = async (key: string): Promise<string | undefined> => {
    const value = (await repository.getSetting(key))?.trim();
    return value ? value : undefined;
  };
  return {
    baseURL: await read(LLM_BASE_URL_SETTING_KEY),
    apiKey: await read(LLM_API_KEY_SETTING_KEY),
    modelId: await read(LLM_MODEL_ID_SETTING_KEY),
  };
}

export const TMDB_API_KEY_SETTING_KEY = "tmdb_api_key";

/** Author-deployed CF Worker that proxies TMDB with the author's key (KV-cached).
 *  env TMDB_PROXY_BASE_URL overrides it (e.g. a user who self-hosts the worker). */
export const DEFAULT_TMDB_PROXY_BASE_URL = "https://media-track-tmdb-proxy.fancydirty.workers.dev";

/** Ordered TMDB access channels: user's own key (direct) → env token (direct) →
 *  the proxy Worker (always last, no token — the Worker injects the author's).
 *  Each HTTP call tries them in order; a dead user key falls through to the proxy. */
export async function getTmdbAccesses(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TmdbAccess[]> {
  const accesses: TmdbAccess[] = [];
  const userKey = (await repository.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim();
  if (userKey) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: userKey });
  }
  const envToken = env.TMDB_READ_TOKEN?.trim();
  if (envToken) {
    accesses.push({ baseURL: TMDB_DIRECT_BASE_URL, readToken: envToken });
  }
  const proxyBase = env.TMDB_PROXY_BASE_URL?.trim() || DEFAULT_TMDB_PROXY_BASE_URL;
  accesses.push({ baseURL: proxyBase });
  return accesses;
}

export const PANSOU_BASE_URL_SETTING_KEY = "pansou_base_url";

/** Default public PanSou instance (author-hosted), used when neither the DB
 *  setting nor env overrides it. The compose stack injects PANSOU_BASE_URL to
 *  point at the bundled `pansou` service instead. */
export const DEFAULT_PANSOU_BASE_URL = "https://so.252035.xyz";

/** The PanSou search aggregator base URL: DB setting > env PANSOU_BASE_URL >
 *  public default. No runtime container auto-detection — compose wires the
 *  service name and this lets a self-hoster override it by hand. */
export async function getPanSouBaseUrl(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dbValue = (await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY))?.trim();
  if (dbValue) return dbValue;
  const envValue = env.PANSOU_BASE_URL?.trim();
  if (envValue) return envValue;
  return DEFAULT_PANSOU_BASE_URL;
}

export const PROWLARR_BASE_URL_SETTING_KEY = "prowlarr_base_url";
export const PROWLARR_API_KEY_SETTING_KEY = "prowlarr_api_key";

/** The user's configured Prowlarr indexer aggregator (Settings → 资源提供商).
 *  Each field undefined when unset/blank → getWorkerResourceProvider skips it. */
export async function getProwlarrConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ baseURL: string | undefined; apiKey: string | undefined }> {
  const read = async (key: string, envKey: string): Promise<string | undefined> => {
    const dbValue = (await repository.getSetting(key))?.trim();
    if (dbValue) return dbValue;
    const envValue = env[envKey]?.trim();
    return envValue ? envValue : undefined;
  };
  return {
    baseURL: await read(PROWLARR_BASE_URL_SETTING_KEY, "PROWLARR_BASE_URL"),
    apiKey: await read(PROWLARR_API_KEY_SETTING_KEY, "PROWLARR_API_KEY"),
  };
}

export const DAILY_SWEEP_TIME_SETTING_KEY = "daily_sweep_time";
/** Default daily 巡检 time (Beijing) when the user hasn't configured one. */
export const DEFAULT_DAILY_SWEEP_TIME = "06:00";

/** The configured daily-sweep time as "HH:MM" (Beijing), or the 06:00 default
 *  when unset/malformed. The self-hosted scheduler fires run-type3 at this time. */
export async function getDailySweepTime(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string> {
  const value = (await repository.getSetting(DAILY_SWEEP_TIME_SETTING_KEY))?.trim();
  return value && /^\d{2}:\d{2}$/.test(value) ? value : DEFAULT_DAILY_SWEEP_TIME;
}

function parseMovieCandidateId(candidateId: string): number | null {
  const match = /^tmdb_movie_(\d+)$/.exec(candidateId);
  return match ? Number(match[1]) : null;
}

export async function movieTargetFromTmdbId(
  tmdbId: number,
): Promise<{ title: MediaTitle; keyword: string } | null> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    return prepareMovieTarget({
      tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getWorkflowRepository())),
    });
  }
  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "movie") {
    return null;
  }
  const title: MediaTitle = {
    id: `tmdb_movie_${candidate.tmdbId}`,
    tmdbId: candidate.tmdbId,
    type: "movie",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    releaseDate: candidate.releaseDate ?? null,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return { title, keyword: candidate.title };
}

export type CandidateReserveRequestResult =
  | { status: "reserved" | "already_running" | "already_tracked"; trackedSeasonId: string }
  | { status: "unsupported"; message: string };

/**
 * 预定 an unreleased film: track it (carrying its release date) WITHOUT running
 * the agent. The daily patrol's air-time gate acquires it once it releases.
 * Movies only (TV/anime have no reserve concept).
 */
export async function reserveCandidate(candidateId: string): Promise<CandidateReserveRequestResult> {
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId === null) {
    return { status: "unsupported", message: "只有电影可以预定。" };
  }
  const movie = await movieTargetFromTmdbId(movieTmdbId);
  if (!movie) {
    return { status: "unsupported", message: "无法获取该电影的信息。" };
  }
  const request = await reserveMovie({ title: movie.title, repository: getWorkflowRepository() });
  return { status: request.status, trackedSeasonId: `${movie.title.id}_movie` };
}

/**
 * Outbound push rides on the feed: whatever notifications a run persisted
 * are delivered to every user-configured channel (DB config > env). Delivery
 * failures are logged, never thrown — the run already succeeded.
 */
async function pushNotificationsSince(
  targetRepository: WorkflowRepository,
  sinceIso: string,
): Promise<void> {
  try {
    const recent = (await targetRepository.listNotifications({ limit: 50 })).filter(
      (notification) => notification.createdAt >= sinceIso,
    );
    if (recent.length === 0) {
      return;
    }

    // A scheduled sweep touches many shows; collapse its notifications into one
    // digest push instead of one message per show. User-triggered events stay
    // per-resource — each is its own message.
    const scheduled = recent.filter((notification) => notification.trigger === "scheduled");
    const individual = recent.filter((notification) => notification.trigger !== "scheduled");

    for (const notification of individual) {
      try {
        await sendPushNotifications({ repository: targetRepository, notification });
      } catch (error) {
        console.error(
          `[media-track] push for ${notification.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (scheduled.length > 0) {
      const digest: NotificationEvent = {
        id: `digest_${sinceIso}`,
        workflowRunId: scheduled[0]!.workflowRunId,
        kind: "daily_digest",
        title: "每日巡检",
        body: formatDailyDigestPushText(scheduled),
        createdAt: new Date().toISOString(),
        trigger: "scheduled",
      };
      try {
        await sendPushNotifications({ repository: targetRepository, notification: digest });
      } catch (error) {
        console.error(
          `[media-track] digest push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(`[media-track] notification push batch failed: ${String(error)}`);
  }
}

export async function queueCandidateSeries(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    const target = await prepareSeriesTarget({
      tmdbId: parsed.tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getWorkflowRepository())),
    });
    const request = await queueSeriesInitialization({
      title: target.title,
      seasons: target.seasons,
      keyword: target.keyword,
      repository: getWorkflowRepository(),
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${target.title.id}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const request = await queueSeriesInitialization({
    title: {
      id: `tmdb_tv_${candidate.tmdbId}`,
      tmdbId: candidate.tmdbId,
      type: "tv",
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases:
        candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    },
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
    repository: getWorkflowRepository(),
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${candidate.tmdbId}_s1`,
  };
}

export const LAST_SWEEP_DATE_SETTING_KEY = "last_sweep_date";

/** Beijing wall-clock "date" (YYYY-MM-DD) and "HH:MM" right now. */
function beijingDateTime(): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

/**
 * The daily 巡检. The configured sweep time is the single source of truth: any
 * trigger (Vercel cron, self-hosted scheduler, manual) just pings this, and the
 * gate runs the sweep at most once per Beijing day, only once the clock has
 * reached the user-configured time — so the Settings time is authoritative
 * regardless of how often the trigger fires. `force` bypasses the gate for
 * on-demand "sweep now".
 */
export async function runScheduledType3(options?: { force?: boolean }): Promise<{
  outcomes: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  skipped?: "already_swept_today" | "before_scheduled_time";
  scheduledFor?: string;
}> {
  const repository = getWorkflowRepository();
  let claimedDay = false;
  if (!options?.force) {
    const target = await getDailySweepTime(repository);
    const { date, hhmm } = beijingDateTime();
    const lastDate = (await repository.getSetting(LAST_SWEEP_DATE_SETTING_KEY))?.trim();
    if (date === lastDate) {
      return { skipped: "already_swept_today", outcomes: [] };
    }
    if (hhmm < target) {
      return { skipped: "before_scheduled_time", scheduledFor: target, outcomes: [] };
    }
    // Claim the day BEFORE running, so a second near-simultaneous trigger no-ops
    // instead of launching a duplicate sweep. If the sweep then fails wholesale
    // (cookie hydration, agent-node init, infra), we RELEASE the claim below so
    // the next ping retries today rather than skipping until tomorrow.
    await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, date);
    claimedDay = true;
  }
  const startedAt = new Date().toISOString();
  let result: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  try {
    await hydratePan115CookieFromDb();
    const sync = tmdbSeasonMetadataSync();
    const accountId = await getCurrentAccountId();
    const { model, preferredLanguage, qualityPreference } = await getAgentModel(repository);
    const parents = await getWorkerStorageParents(accountId);
    result = await runScheduledType3Monitoring({
      repository,
      resourceProvider: await getWorkerResourceProvider(),
      storage: await getWorkerStorageExecutor(accountId),
      model,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: parents.tv,
      animeStorageParentDirectoryId: parents.anime,
      moviesParentDirectoryId: parents.movies,
      staleActiveRunTimeoutMs: 30 * 60 * 1000,
      ...(sync ? { syncSeasonMetadata: sync } : {}),
    });
    await pushNotificationsSince(repository, startedAt);
    return { outcomes: result };
  } catch (error) {
    // The sweep failed before completing — release today's claim so the next
    // ping retries instead of skipping until tomorrow. Per-season failures are
    // swallowed inside the monitor, so this only fires on infra-level errors.
    if (claimedDay) {
      try {
        await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, "");
      } catch {
        // best-effort release; nothing else to do
      }
    }
    throw error;
  }
}

/**
 * The Type 3 sweep's TMDB re-sync (the GUI's `sync_all`): refresh each tracked
 * season's aired/total from TMDB so the sweep discovers episodes that aired
 * after tracking began. Returns undefined when TMDB isn't configured, leaving
 * the sweep on stored counts.
 */
function tmdbSeasonMetadataSync(): SeasonMetadataSync | undefined {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER !== "tmdb") {
    return undefined;
  }
  return async ({ tmdbId, seasonNumber }) => {
    const target = await prepareTrackingTarget({
      tmdbId,
      mediaType: "tv",
      seasonNumber,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getWorkflowRepository())),
    });
    return {
      latestAiredEpisode: target.season.latestAiredEpisode,
      totalEpisodes: target.season.totalEpisodes,
    };
  };
}

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}

async function trackingTargetFromCandidateId(candidateId: string): Promise<{
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return null;
  }

  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    return prepareTrackingTarget({
      tmdbId: parsed.tmdbId,
      mediaType: "tv",
      seasonNumber: parsed.seasonNumber,
      qualityPreference: defaultQuality(),
      storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
      metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getWorkflowRepository())),
    });
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  return targetFromSearchCandidate(candidate, parsed.seasonNumber, candidateId);
}

function targetFromSearchCandidate(
  candidate: MediaSearchCandidate,
  seasonNumber: number,
  candidateId: string,
): {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null {
  const season = candidate.seasons.find((item) => item.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const titleId = `tmdb_tv_${candidate.tmdbId}`;
  const title: MediaTitle = {
    id: titleId,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases: candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
  };
  const trackedSeason: TrackedSeason = {
    id: candidateId,
    mediaTitleId: title.id,
    seasonNumber,
    status: season.latestAiredEpisode >= season.episodeCount ? "completed" : "active",
    qualityPreference: defaultQuality(),
    storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
    totalEpisodes: season.episodeCount,
    latestAiredEpisode: season.latestAiredEpisode,
    latestAiredSource: "metadata",
  };
  return {
    title,
    season: trackedSeason,
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
  };
}

function parseTvCandidateId(candidateId: string): { tmdbId: number; seasonNumber: number } | null {
  const match = /^tmdb_tv_(\d+)_s(\d+)$/.exec(candidateId);
  if (!match) {
    return null;
  }
  return {
    tmdbId: Number(match[1]),
    seasonNumber: Number(match[2]),
  };
}

async function getWorkerResourceProvider(): Promise<ResourceProvider> {
  if (process.env.MEDIA_TRACK_WORKFLOW_ADAPTER === "pansou") {
    const providers: Array<{ name: string; provider: ResourceProvider }> = [
      { name: "pansou", provider: new PanSouResourceProvider({ baseURL: await getPanSouBaseUrl(getWorkflowRepository()) }) },
    ];
    const prowlarr = await getProwlarrConfig(getWorkflowRepository());
    if (prowlarr.baseURL && prowlarr.apiKey) {
      providers.push({
        name: "prowlarr",
        provider: new ProwlarrResourceProvider({ baseURL: prowlarr.baseURL, apiKey: prowlarr.apiKey }),
      });
    }
    return providers.length > 1
      ? new CompositeResourceProvider({ providers })
      : providers[0]!.provider;
  }
  fakeResourceProvider ??= new FakeResourceProvider({
    keywordResults: {
      "翘楚 4K": [
        {
          title: "翘楚 S01E01-S01E12 4K",
          episodeHints: episodeCodes(1, 12),
          qualityHints: ["4K"],
        },
      ],
      "绝命毒师 4K": [
        {
          title: "绝命毒师 S01E01-S01E07 4K",
          episodeHints: episodeCodes(1, 7),
          qualityHints: ["4K"],
        },
      ],
    },
  });
  return fakeResourceProvider;
}

/** §7: the account's 115 credentials (cookie + category CIDs) from its
 *  connected_storages record. null when the account hasn't connected a 115 yet
 *  (then the worker falls back to the legacy env cookie / env CIDs). */
interface AccountStorageCredentials {
  cookie: string;
  rootCid: string | null;
  moviesCid: string | null;
  tvCid: string | null;
  animeCid: string | null;
}

async function getAccountStorageCredentials(
  accountId: string,
): Promise<AccountStorageCredentials | null> {
  try {
    const storages = await getWorkflowRepository().listConnectedStorages(accountId);
    const pan115 = storages.find((storage) => storage.provider === "pan115");
    const cookie = (pan115?.payload as { cookie?: string } | null)?.cookie?.trim();
    if (!pan115 || !cookie) {
      return null;
    }
    return {
      cookie,
      rootCid: pan115.rootCid,
      moviesCid: pan115.moviesCid,
      tvCid: pan115.tvCid,
      animeCid: pan115.animeCid,
    };
  } catch (error) {
    console.error(`[media-track] failed to load 115 credentials for ${accountId}: ${String(error)}`);
    return null;
  }
}

/**
 * §7 P0: the worker resolves the 115 executor from the run's account credentials
 * (connected_storages.payload.cookie) instead of the global env cookie. Single-
 * user is unchanged: the migrated default-account cookie is byte-identical to the
 * env one. Falls back to the env cookie when the account has no 115 connection
 * (fresh deploy before QR connect, or the legacy env-only path).
 */
async function getWorkerStorageExecutor(
  accountId: string = DEFAULT_ACCOUNT_ID,
): Promise<StorageExecutor> {
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake";
  if (adapter === "115") {
    const creds = await getAccountStorageCredentials(accountId);
    const env = creds ? { ...process.env, PAN115_COOKIE: creds.cookie } : process.env;
    return createProtectedPan115CookieStorageExecutorFromEnv({ env });
  }
  if (adapter !== "fake") {
    throw new Error(`MEDIA_TRACK_STORAGE_ADAPTER_UNSUPPORTED: ${adapter}`);
  }
  fakeStorageExecutor ??= new FakeStorageExecutor({
    transferOutcomes: fakeTransferOutcomes(),
  });
  return fakeStorageExecutor;
}

/**
 * The 115 landing parent CIDs for a run's account. Sourced from the account's
 * connected_storage (set at connect-time directory provision); falls back to the
 * env CIDs when the account has no 115 connection or the adapter is fake.
 */
async function getWorkerStorageParents(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  tv: string;
  anime: string;
  movies: string;
}> {
  const creds =
    process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115"
      ? await getAccountStorageCredentials(accountId)
      : null;
  return {
    tv: creds?.tvCid || storageParentDirectoryId(),
    anime: creds?.animeCid || creds?.tvCid || animeParentDirectoryId(),
    movies: creds?.moviesCid || moviesParentDirectoryId(),
  };
}

/**
 * The V2 acquisition agent is a bare LanguageModel driving the sandbox tool-loop
 * (not the old AgentNodes). The adapter policy forces vercel-ai whenever the live
 * PanSou provider or 115 storage is in use; the fake adapter gets a no-op stub so
 * dev/demo runs complete without a real model. The preferred subtitle language is
 * passed to each workflow as standing context, not baked into the model instance.
 */
async function getAgentModel(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{
  model: ReturnType<typeof createAgentModelFromEnv>;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
}> {
  assertWorkflowAgentAdapterPolicy(process.env);
  const env = process.env;
  const adapter = env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai" ? "vercel-ai" : "fake";
  const preferredLanguage = await getPreferredLanguage(repository);
  const qualityPreference = await getQualityPreference(repository);

  // Resolve the live model config DB-first, then .env, then the built-in MiMo
  // defaults (inside createAgentModel). Settings → AI 模型 thus overrides .env.
  const llm = await getLlmConfig(repository);
  const apiKey = llm.apiKey ?? env.AGENT_MODEL_API_KEY ?? env.XIAOMI_MIMO_API_KEY;
  const baseURL = llm.baseURL ?? env.AGENT_MODEL_BASE_URL ?? env.XIAOMI_MIMO_BASE_URL;
  const modelId = llm.modelId ?? env.AGENT_MODEL_ID ?? env.XIAOMI_MIMO_MODEL_ID;
  const resolved = {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(modelId === undefined ? {} : { modelId }),
  };
  // Rebuild the cached model whenever adapter OR resolved config changes (so a
  // Settings edit takes effect without a restart).
  const signature = `${adapter}|${baseURL ?? ""}|${modelId ?? ""}|${apiKey ?? ""}`;
  if (agentModel?.signature !== signature) {
    agentModel = {
      signature,
      model: adapter === "vercel-ai" ? createAgentModel(resolved) : createStubAcquisitionModel(),
    };
  }
  return { model: agentModel.model, preferredLanguage, qualityPreference };
}

function fakeTransferOutcomes() {
  const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: VerifiedFile[] }> = {};
  for (let snapshotNumber = 1; snapshotNumber <= 20; snapshotNumber += 1) {
    const candidateId = `snapshot_${snapshotNumber}_candidate_1`;
    outcomes[candidateId] = {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: episodeCodes(1, 24).map((code) => fakeVerifiedFile(candidateId, code)),
    };
  }
  return outcomes;
}

function fakeVerifiedFile(candidateId: string, code: string): VerifiedFile {
  return {
    id: `${candidateId}_${code}`,
    storageDirectoryId: "assigned_by_fake_storage",
    name: `Demo.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${candidateId}_${code}`,
  };
}

function episodeCodes(seasonNumber: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => episodeCode(seasonNumber, index + 1));
}

function storageDirectoryIdForCandidate(_candidateId: string): string {
  // Empty means "let the Type 2 workflow create the canonical
  // `Title (Year)/Season N` directory under the configured parent".
  return process.env.MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID ?? "";
}

function storageParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_TV_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_library_root"
  );
}

/**
 * Separate 115 landing parent for anime. Falls back to the TV parent when
 * MEDIA_TRACK_ANIME_PARENT_CID is unset, so anime simply co-locates with TV
 * until a dedicated Anime directory is configured.
 */
function animeParentDirectoryId(): string {
  return process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? storageParentDirectoryId();
}

function defaultQuality(): string {
  return process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K";
}

export interface ForeignWorkFinding {
  stagingDirectoryId: string;
  files: Array<{ providerFileId: string; sourcePath: string }>;
}

export interface ForeignWorkReview {
  workflowRunId: string;
  titleName: string;
  findings: ForeignWorkFinding[];
}

/** Foreign-work findings recorded by a run, for the user-confirmation page. */
export async function getForeignWorkReview(workflowRunId: string): Promise<ForeignWorkReview | null> {
  const repository = getWorkflowRepository();
  const snapshot = await repository.getWorkflowRunSnapshot(workflowRunId, await getCurrentAccountId());
  if (!snapshot) {
    return null;
  }
  const findings = snapshot.workflowRun.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event) => event.data as unknown as ForeignWorkFinding)
    .filter((finding) => Array.isArray(finding?.files) && finding.files.length > 0);
  return { workflowRunId, titleName: snapshot.title.title, findings };
}

export async function importForeignWorkFiles(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<{ movieDirectoryId: string; movedFileIds: string[] }> {
  const accountId = await getCurrentAccountId();
  const parents = await getWorkerStorageParents(accountId);
  return importForeignWorkAsMovie({
    storage: await getWorkerStorageExecutor(accountId),
    providerFileIds: input.providerFileIds,
    movieTitle: input.movieTitle,
    year: input.year,
    moviesParentDirectoryId: parents.movies,
  });
}

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

// ---------------------------------------------------------------------------
// 115 connection (QR login) — cookie lives in the DB once connected; the
// repo-root .env PAN115_COOKIE remains the bootstrap fallback.

const PAN115_COOKIE_KEY = "pan115.cookie";
const PAN115_META_KEY = "pan115.cookieMeta";

let pan115CookieHydrated = false;

/** DB cookie (newer truth from QR connect) wins over the .env bootstrap. */
export async function hydratePan115CookieFromDb(): Promise<void> {
  if (pan115CookieHydrated) {
    return;
  }
  pan115CookieHydrated = true;
  try {
    const cookie = await getWorkflowRepository().getSetting(PAN115_COOKIE_KEY);
    if (cookie) {
      process.env.PAN115_COOKIE = cookie;
    }
  } catch (error) {
    console.error(`[media-track] failed to hydrate 115 cookie from DB: ${String(error)}`);
  }
}

export interface Pan115ConnectionStatus {
  connected: boolean;
  source: "qr" | "env" | "none";
  userName: string | null;
  app: string | null;
  connectedAt: string | null;
}

export async function getPan115ConnectionStatus(): Promise<Pan115ConnectionStatus> {
  const repository = getWorkflowRepository();
  const cookie = await repository.getSetting(PAN115_COOKIE_KEY);
  if (cookie) {
    const metaRaw = await repository.getSetting(PAN115_META_KEY);
    let meta: { userName?: string; app?: string; connectedAt?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      connected: true,
      source: "qr",
      userName: meta.userName ?? null,
      app: meta.app ?? null,
      connectedAt: meta.connectedAt ?? null,
    };
  }
  if (process.env.PAN115_COOKIE) {
    return { connected: true, source: "env", userName: null, app: null, connectedAt: null };
  }
  return { connected: false, source: "none", userName: null, app: null, connectedAt: null };
}

export async function completePan115QrLogin(input: {
  session: { uid: string; time: number; sign: string; qrcodeContent: string };
  app?: string;
}): Promise<{ userName: string; app: string }> {
  const { Pan115QrLoginClient, PAN115_QR_LOGIN_APPS } = await import("@media-track/workflow");
  const app = (PAN115_QR_LOGIN_APPS as readonly string[]).includes(input.app ?? "")
    ? (input.app as (typeof PAN115_QR_LOGIN_APPS)[number])
    : "alipaymini";
  const client = new Pan115QrLoginClient();
  const result = await client.exchangeCookie(input.session, app);
  const repository = getWorkflowRepository();
  await repository.setSetting(PAN115_COOKIE_KEY, result.cookie);
  await repository.setSetting(
    PAN115_META_KEY,
    JSON.stringify({
      userName: result.userName,
      app: result.app,
      connectedAt: new Date().toISOString(),
    }),
  );
  // Take effect immediately: the 115 executor is built from process.env per call.
  process.env.PAN115_COOKIE = result.cookie;
  pan115CookieHydrated = true;
  return { userName: result.userName, app: result.app };
}
