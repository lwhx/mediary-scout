import {
  DEFAULT_ACCOUNT_ID,
  type AgentDecision,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowKind,
  type WorkflowRun,
  type WorkflowRunProgress,
  type WorkflowStatus,
} from "./domain.js";
import { MAGNET_DEAD_LINK_TTL_MS } from "./acquisition-v2/dead-links.js";
import type { DeadLink, DeadLinkStore } from "./acquisition-v2/dead-links.js";
import type {
  Account,
  ConnectedStorage,
  Session,
  UpsertConnectedStorageInput,
} from "./account-credentials.js";

export interface PersistWorkflowRunSnapshotInput {
  /** Owning account. Optional at the call site (single-user = implicit
   *  acct_default); the repository stamps it onto the account_id column. */
  accountId?: string;
  title: MediaTitle;
  season: TrackedSeason;
  workflowRun: WorkflowRun;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
  notifications: NotificationEvent[];
}

export interface PersistedWorkflowRunSnapshot extends PersistWorkflowRunSnapshotInput {
  /** Resolved owning account (always set — the worker uses it to load per-run
   *  credentials when it claims the run). */
  accountId: string;
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
}

export interface TrackedSeasonState {
  /** Resolved owning account of this tracking record. */
  accountId: string;
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
}

export interface ReserveWorkflowRunInput extends PersistWorkflowRunSnapshotInput {
  blockIfEpisodeStatesExist?: boolean;
  /**
   * Title-level mutual exclusion: refuse the reservation if ANY run for the
   * same media title is already active, regardless of season or kind. All
   * seasons of a title share one `Title (Year)/` show directory and staging
   * parent, so two concurrent acquisition runs would race on directory
   * creation, staging, and dedup. User-triggered acquisitions set this so a
   * user clicking "get S1", "get S2", "get S3" in quick succession can never
   * spawn overlapping writers on the same title.
   */
  blockIfTitleHasActiveRun?: boolean;
  staleActiveRunStartedBefore?: string;
  staleFinishedAt?: string;
}

export type WorkflowRunReservationResult =
  | {
      status: "reserved";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_active";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_has_episode_state";
      episodes: EpisodeState[];
    };

export interface WorkflowRepository extends DeadLinkStore {
  saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void>;
  reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult>;
  /** Account-scoped: returns null if the run belongs to a different account.
   *  Defaults to acct_default (single-user / fail-closed). */
  getWorkflowRunSnapshot(
    workflowRunId: string,
    accountId?: string,
  ): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Cross-account: the single-instance worker drains every account's queue.
   *  The returned snapshot carries `accountId` so the worker can load that
   *  account's credentials. */
  claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /**
   * Reset every "running" workflow run back to "queued". For the single-instance
   * in-process worker this is crash recovery: only that worker executes runs, so
   * any run still "running" when the process (re)starts is orphaned by a dead
   * worker and must be re-claimed, not left stuck forever. Returns how many were
   * requeued.
   */
  requeueRunningWorkflowRuns(): Promise<number>;
  findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Every queued/running run for the account, newest first — drives the library
   *  "获取中" placeholders. Defaults to acct_default. */
  listActiveWorkflowRuns(accountId?: string): Promise<PersistedWorkflowRunSnapshot[]>;
  /** Lightweight mid-run update of the live agent progress shown on the activity
   *  page; `percent` is clamped monotonic so retries never rewind the bar. No-op
   *  for an unknown run. */
  updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void>;
  /**
   * Cancel a still-QUEUED run (user changed their mind). Deletes the run AND the
   * tracking it created (the run snapshot is the title/season's only source until
   * the worker runs it), so the title vanishes from the library too — like the
   * 获取 click never happened. Refuses (not_cancellable) once the worker has
   * claimed it (running) or it is otherwise non-queued; that race is expected.
   * Pure DB: a queued run has created no 115 directories yet.
   */
  cancelQueuedWorkflowRun(
    workflowRunId: string,
    accountId?: string,
  ): Promise<{ status: "cancelled" | "not_cancellable" }>;
  getTrackedSeasonState(trackedSeasonId: string, accountId?: string): Promise<TrackedSeasonState | null>;
  listTrackedSeasonStates(accountId?: string): Promise<TrackedSeasonState[]>;
  /** EVERY account's tracked seasons (cross-account), each carrying its own
   *  accountId — drives the daily sweep, which patrols all users' shows and runs
   *  each under its owner's credentials. */
  listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]>;
  listEpisodeStates(trackedSeasonId: string, accountId?: string): Promise<EpisodeState[]>;
  /** Most-recent-first notification feed for the account. Defaults to acct_default. */
  listNotifications(input?: { limit?: number; accountId?: string }): Promise<NotificationEvent[]>;
  /** Cross-account recent notifications, each tagged with its run's owning account
   *  — drives the worker's outbound push, which must deliver each user's events to
   *  THAT user's channels. Newest first. */
  listRecentNotificationsWithAccount(input?: {
    limit?: number;
  }): Promise<Array<{ accountId: string; notification: NotificationEvent }>>;
  /** Instance-level (global) settings, e.g. the multi-account migration marker. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Per-account settings: LLM/TMDB/Prowlarr/PanSou/画质/语言/push, etc. */
  getAccountSetting(accountId: string, key: string): Promise<string | null>;
  setAccountSetting(accountId: string, key: string, value: string): Promise<void>;
  /** Connected network drives owned by the account (§7 multi-account). */
  listConnectedStorages(accountId: string): Promise<ConnectedStorage[]>;
  upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void>;
  /** Instance-wide lookup enforcing UNIQUE(provider, provider_uid) ownership. */
  findConnectedStorageByUid(provider: string, providerUid: string): Promise<ConnectedStorage | null>;
  /** Accounts + sessions (§7 P1 auth). createAccount throws on a duplicate
   *  username (UNIQUE), surfaced to the register route as "用户名已存在". */
  createAccount(account: Account): Promise<void>;
  getAccountByUsername(username: string): Promise<Account | null>;
  getAccountById(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  // recordDeadLink + listDeadLinkKeys come from DeadLinkStore.
}

/** Thrown by createAccount when the username is already taken. */
export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`Username already exists: ${username}`);
    this.name = "DuplicateUsernameError";
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly workflowRuns = new Map<string, PersistWorkflowRunSnapshotInput>();
  private readonly episodesBySeason = new Map<string, EpisodeState[]>();
  private readonly settings = new Map<string, string>();
  private readonly accountSettings = new Map<string, Map<string, string>>();
  private readonly connectedStorages = new Map<string, ConnectedStorage>();
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, Session>();
  private readonly deadLinks = new Map<string, DeadLink>();

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async getAccountSetting(accountId: string, key: string): Promise<string | null> {
    return this.accountSettings.get(accountId)?.get(key) ?? null;
  }

  async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
    let bucket = this.accountSettings.get(accountId);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.accountSettings.set(accountId, bucket);
    }
    bucket.set(key, value);
  }

  async listConnectedStorages(accountId: string): Promise<ConnectedStorage[]> {
    return [...this.connectedStorages.values()]
      .filter((storage) => storage.accountId === accountId)
      .map((storage) => ({ ...storage }));
  }

  async upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void> {
    const key = connectedStorageKey(row.provider, row.providerUid);
    const existing = this.connectedStorages.get(key);
    // Instance-wide UNIQUE(provider, provider_uid) ownership: a different account
    // can NEVER take over (or overwrite) a 网盘 already bound to someone else.
    // The binding path (resolveStorageBinding) rejects first; this is the DB-level
    // backstop so the primitive itself can't be used to steal ownership.
    if (existing && existing.accountId !== row.accountId) {
      return;
    }
    this.connectedStorages.set(key, {
      id: row.id,
      accountId: row.accountId,
      provider: row.provider,
      providerUid: row.providerUid,
      label: row.label ?? null,
      payload: row.payload,
      rootCid: row.rootCid ?? null,
      moviesCid: row.moviesCid ?? null,
      tvCid: row.tvCid ?? null,
      animeCid: row.animeCid ?? null,
      // Mirror Postgres: ON CONFLICT refresh does NOT touch status, so a re-scan
      // (refresh) keeps an existing frozen state until an explicit unfreeze.
      status: existing?.status ?? "active",
      frozenReason: existing?.frozenReason ?? null,
      frozenAt: existing?.frozenAt ?? null,
      createdAt: row.createdAt,
    });
  }

  async findConnectedStorageByUid(
    provider: string,
    providerUid: string,
  ): Promise<ConnectedStorage | null> {
    const found = this.connectedStorages.get(connectedStorageKey(provider, providerUid));
    return found ? { ...found } : null;
  }

  async createAccount(account: Account): Promise<void> {
    for (const existing of this.accounts.values()) {
      if (existing.username === account.username) {
        throw new DuplicateUsernameError(account.username);
      }
    }
    this.accounts.set(account.id, { ...account });
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    for (const account of this.accounts.values()) {
      if (account.username === username) {
        return { ...account };
      }
    }
    return null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    const found = this.accounts.get(id);
    return found ? { ...found } : null;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSession(id: string): Promise<Session | null> {
    const found = this.sessions.get(id);
    return found ? { ...found } : null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async recordDeadLink(input: {
    key: string;
    kind: DeadLink["kind"];
    reason: string;
    permanent: boolean;
    ttlMs?: number;
    now?: string;
  }): Promise<void> {
    // Idempotent: keep the first record (when it was first proven dead).
    if (this.deadLinks.has(input.key)) {
      return;
    }
    const recordedAt = input.now ?? new Date().toISOString();
    this.deadLinks.set(input.key, {
      key: input.key,
      kind: input.kind,
      reason: input.reason,
      permanent: input.permanent,
      recordedAt,
      expiresAt: input.permanent
        ? null
        : new Date(new Date(recordedAt).getTime() + (input.ttlMs ?? MAGNET_DEAD_LINK_TTL_MS)).toISOString(),
    });
  }

  async listDeadLinkKeys(options?: { now?: string }): Promise<string[]> {
    const now = options?.now ?? new Date().toISOString();
    return [...this.deadLinks.values()]
      .filter((link) => link.expiresAt === null || link.expiresAt > now)
      .map((link) => link.key);
  }

  async saveWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): Promise<void> {
    validateWorkflowRunSnapshot(input);

    const cloned = cloneWorkflowValue(input);
    cloned.accountId = cloned.accountId ?? DEFAULT_ACCOUNT_ID;
    this.workflowRuns.set(cloned.workflowRun.id, cloned);
    this.episodesBySeason.set(cloned.season.id, cloneWorkflowValue(cloned.episodes));
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = workflowSnapshotFromReservation(input);
    validateWorkflowRunSnapshot(snapshot);
    this.expireStaleActiveWorkflowRuns(input);

    if (input.blockIfTitleHasActiveRun === true) {
      const reservingAccountId = snapshot.accountId ?? DEFAULT_ACCOUNT_ID;
      const titleActive = Array.from(this.workflowRuns.values())
        .filter(
          (stored) =>
            (stored.accountId ?? DEFAULT_ACCOUNT_ID) === reservingAccountId &&
            stored.season.mediaTitleId === snapshot.season.mediaTitleId &&
            isActiveWorkflowStatus(stored.workflowRun.status),
        )
        .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
      if (titleActive) {
        return {
          status: "already_active",
          snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(titleActive)),
        };
      }
    }

    const activeRun = await this.findActiveWorkflowRun({
      trackedSeasonId: snapshot.season.id,
      kind: snapshot.workflowRun.kind,
      accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
    });
    if (activeRun) {
      return {
        status: "already_active",
        snapshot: activeRun,
      };
    }

    const existingEpisodes = this.episodesBySeason.get(snapshot.season.id) ?? [];
    if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
      return {
        status: "already_has_episode_state",
        episodes: cloneWorkflowValue(existingEpisodes),
      };
    }

    const cloned = cloneWorkflowValue(snapshot);
    cloned.accountId = cloned.accountId ?? DEFAULT_ACCOUNT_ID;
    this.workflowRuns.set(cloned.workflowRun.id, cloned);
    this.episodesBySeason.set(cloned.season.id, cloneWorkflowValue(cloned.episodes));

    return {
      status: "reserved",
      snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(cloned)),
    };
  }

  async getWorkflowRunSnapshot(
    workflowRunId: string,
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored || (stored.accountId ?? DEFAULT_ACCOUNT_ID) !== accountId) {
      return null;
    }

    return withDerivedEpisodeSummaries(cloneWorkflowValue(stored));
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const queuedRun = Array.from(this.workflowRuns.values())
      .filter((snapshot) => snapshot.workflowRun.kind === input.kind && snapshot.workflowRun.status === "queued")
      .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))[0];
    if (!queuedRun) {
      return null;
    }

    const claimed = cloneWorkflowValue({
      ...queuedRun,
      workflowRun: claimWorkflowRun(queuedRun.workflowRun, input.now),
    });
    this.workflowRuns.set(claimed.workflowRun.id, claimed);

    return withDerivedEpisodeSummaries(cloneWorkflowValue(claimed));
  }

  async requeueRunningWorkflowRuns(): Promise<number> {
    let requeued = 0;
    for (const [id, snapshot] of this.workflowRuns) {
      if (snapshot.workflowRun.status !== "running") {
        continue;
      }
      this.workflowRuns.set(id, {
        ...snapshot,
        workflowRun: { ...snapshot.workflowRun, status: "queued", finishedAt: null },
      });
      requeued += 1;
    }
    return requeued;
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
    const activeRuns = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId &&
          snapshot.workflowRun.trackedSeasonId === input.trackedSeasonId &&
          snapshot.workflowRun.kind === input.kind &&
          isActiveWorkflowStatus(snapshot.workflowRun.status),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    const latest = activeRuns[0];
    return latest ? withDerivedEpisodeSummaries(cloneWorkflowValue(latest)) : null;
  }

  async listActiveWorkflowRuns(
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<PersistedWorkflowRunSnapshot[]> {
    return Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId &&
          isActiveWorkflowStatus(snapshot.workflowRun.status),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))
      .map((snapshot) => withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)));
  }

  async updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void> {
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored) {
      return;
    }
    const previousPercent = stored.workflowRun.progress?.percent ?? 0;
    this.workflowRuns.set(workflowRunId, {
      ...stored,
      workflowRun: {
        ...stored.workflowRun,
        progress: { ...progress, percent: Math.max(previousPercent, progress.percent) },
      },
    });
  }

  async cancelQueuedWorkflowRun(
    workflowRunId: string,
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<{ status: "cancelled" | "not_cancellable" }> {
    const stored = this.workflowRuns.get(workflowRunId);
    if (
      !stored ||
      (stored.accountId ?? DEFAULT_ACCOUNT_ID) !== accountId ||
      stored.workflowRun.status !== "queued"
    ) {
      return { status: "not_cancellable" };
    }
    const seasonId = stored.season.id;
    this.workflowRuns.delete(workflowRunId);
    const seasonStillReferenced = Array.from(this.workflowRuns.values()).some(
      (snapshot) => snapshot.season.id === seasonId,
    );
    if (!seasonStillReferenced) {
      this.episodesBySeason.delete(seasonId);
    }
    return { status: "cancelled" };
  }

  async getTrackedSeasonState(
    trackedSeasonId: string,
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<TrackedSeasonState | null> {
    const latestSnapshot = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          snapshot.season.id === trackedSeasonId &&
          (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId,
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
    if (!latestSnapshot) {
      return null;
    }

    return cloneWorkflowValue({
      accountId: latestSnapshot.accountId ?? DEFAULT_ACCOUNT_ID,
      title: latestSnapshot.title,
      season: latestSnapshot.season,
      episodes: this.episodesBySeason.get(trackedSeasonId) ?? latestSnapshot.episodes,
    });
  }

  async listTrackedSeasonStates(
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<TrackedSeasonState[]> {
    const latestBySeason = new Map<string, PersistWorkflowRunSnapshotInput>();
    const snapshots = Array.from(this.workflowRuns.values())
      .filter((snapshot) => (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId)
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    for (const snapshot of snapshots) {
      if (!latestBySeason.has(snapshot.season.id)) {
        latestBySeason.set(snapshot.season.id, snapshot);
      }
    }

    return Array.from(latestBySeason.values())
      .map((snapshot) =>
        cloneWorkflowValue({
          accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
          title: snapshot.title,
          season: snapshot.season,
          episodes: this.episodesBySeason.get(snapshot.season.id) ?? snapshot.episodes,
        }),
      )
      .sort(compareTrackedSeasonStates);
  }

  async listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    const latestBySeason = new Map<string, PersistWorkflowRunSnapshotInput>();
    const snapshots = Array.from(this.workflowRuns.values()).sort((a, b) =>
      b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt),
    );
    for (const snapshot of snapshots) {
      if (!latestBySeason.has(snapshot.season.id)) {
        latestBySeason.set(snapshot.season.id, snapshot);
      }
    }
    return Array.from(latestBySeason.values())
      .map((snapshot) =>
        cloneWorkflowValue({
          accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
          title: snapshot.title,
          season: snapshot.season,
          episodes: this.episodesBySeason.get(snapshot.season.id) ?? snapshot.episodes,
        }),
      )
      .sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(
    trackedSeasonId: string,
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<EpisodeState[]> {
    // Episodes inherit ownership from their season — only return them if the
    // season belongs to the requesting account.
    const ownerMatches = Array.from(this.workflowRuns.values()).some(
      (snapshot) =>
        snapshot.season.id === trackedSeasonId &&
        (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId,
    );
    if (!ownerMatches) {
      return [];
    }
    return cloneWorkflowValue(this.episodesBySeason.get(trackedSeasonId) ?? []);
  }

  async listNotifications(input?: {
    limit?: number;
    accountId?: string;
  }): Promise<NotificationEvent[]> {
    const accountId = input?.accountId ?? DEFAULT_ACCOUNT_ID;
    const all = [...this.workflowRuns.values()]
      .filter((snapshot) => (snapshot.accountId ?? DEFAULT_ACCOUNT_ID) === accountId)
      .flatMap((snapshot) => snapshot.notifications.map((notification) => ({ ...notification })));
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  async listRecentNotificationsWithAccount(input?: {
    limit?: number;
  }): Promise<Array<{ accountId: string; notification: NotificationEvent }>> {
    const all = [...this.workflowRuns.values()].flatMap((snapshot) =>
      snapshot.notifications.map((notification) => ({
        accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
        notification: { ...notification },
      })),
    );
    all.sort((left, right) => right.notification.createdAt.localeCompare(left.notification.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  private expireStaleActiveWorkflowRuns(input: ReserveWorkflowRunInput): void {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const reservationSnapshot = workflowSnapshotFromReservation(input);
    const staleRuns = Array.from(this.workflowRuns.values()).filter(
      (stored) =>
        stored.workflowRun.trackedSeasonId === reservationSnapshot.season.id &&
        stored.workflowRun.kind === reservationSnapshot.workflowRun.kind &&
        isActiveWorkflowStatus(stored.workflowRun.status) &&
        stored.workflowRun.startedAt < input.staleActiveRunStartedBefore!,
    );

    for (const staleRun of staleRuns) {
      const expired = cloneWorkflowValue({
        ...staleRun,
        workflowRun: expireWorkflowRun(
          staleRun.workflowRun,
          input.staleFinishedAt ?? reservationSnapshot.workflowRun.startedAt,
        ),
        episodes: [],
      });
      this.workflowRuns.set(expired.workflowRun.id, expired);
      this.episodesBySeason.set(expired.season.id, []);
    }
  }
}

export function validateWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): void {
  if (input.season.mediaTitleId !== input.title.id) {
    throw new Error("Tracked season does not belong to media title");
  }
  if (input.workflowRun.trackedSeasonId !== input.season.id) {
    throw new Error("Workflow run does not belong to tracked season");
  }

  for (const episode of input.episodes) {
    if (episode.trackedSeasonId !== input.season.id) {
      throw new Error(`Episode ${episode.episodeCode} does not belong to tracked season`);
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (transferAttempt.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Transfer attempt ${transferAttempt.id} does not belong to workflow run`);
    }
  }

  for (const notification of input.notifications) {
    if (notification.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Notification ${notification.id} does not belong to workflow run`);
    }
  }

  const candidateIdsBySnapshot = new Map<string, Set<string>>();
  const allCandidateIds = new Set<string>();
  for (const snapshot of input.resourceSnapshots) {
    const snapshotCandidateIds = new Set<string>();
    for (const candidate of snapshot.candidates) {
      if (candidate.snapshotId !== snapshot.id) {
        throw new Error(`Resource candidate ${candidate.id} does not belong to snapshot ${snapshot.id}`);
      }
      snapshotCandidateIds.add(candidate.id);
      allCandidateIds.add(candidate.id);
    }
    candidateIdsBySnapshot.set(snapshot.id, snapshotCandidateIds);
  }

  for (const decision of input.decisions) {
    const candidateIds = candidateIdsBySnapshot.get(decision.snapshotId);
    if (!candidateIds) {
      throw new Error(`Agent decision referenced unknown resource snapshot ${decision.snapshotId}`);
    }

    const decisionCandidateIds = [
      ...decision.selectedCandidateIds,
      ...decision.rejectedCandidateIds,
      ...Object.keys(decision.episodeMapping),
      ...Object.keys(decision.providerAheadEpisodeMapping),
    ];
    if (decisionCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
      throw new Error("Agent decision referenced candidates outside persisted resource snapshots");
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (!allCandidateIds.has(transferAttempt.candidateId)) {
      throw new Error(`Transfer attempt ${transferAttempt.id} referenced an unknown candidate`);
    }
  }
}

export function withDerivedEpisodeSummaries(input: PersistWorkflowRunSnapshotInput): PersistedWorkflowRunSnapshot {
  return {
    ...input,
    accountId: input.accountId ?? DEFAULT_ACCOUNT_ID,
    obtainedEpisodes: input.episodes
      .filter((episode) => episode.obtained)
      .map((episode) => episode.episodeCode),
    providerAheadEpisodes: input.episodes
      .filter((episode) => episode.obtained && episode.metadataStatus === "provider_ahead")
      .map((episode) => episode.episodeCode),
  };
}

/** Instance-wide key for the UNIQUE(provider, provider_uid) ownership index. */
export function connectedStorageKey(provider: string, providerUid: string): string {
  return `${provider}:${providerUid}`;
}

export function cloneWorkflowValue<T>(value: T): T {
  return structuredClone(value);
}

export function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "queued" || status === "running";
}

export function workflowSnapshotFromReservation(input: ReserveWorkflowRunInput): PersistWorkflowRunSnapshotInput {
  const {
    blockIfEpisodeStatesExist: _blockIfEpisodeStatesExist,
    staleActiveRunStartedBefore: _staleActiveRunStartedBefore,
    staleFinishedAt: _staleFinishedAt,
    ...snapshot
  } = input;
  return snapshot;
}

export function expireWorkflowRun(workflowRun: WorkflowRun, finishedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "failed",
    finishedAt,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_expired",
        message: `Expired stale active workflow run ${workflowRun.id}`,
      },
    ],
  };
}

export function claimWorkflowRun(workflowRun: WorkflowRun, claimedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "running",
    finishedAt: null,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_claimed",
        message: `Claimed queued workflow run ${workflowRun.id}`,
        data: { claimedAt },
      },
    ],
  };
}

export function compareTrackedSeasonStates(a: TrackedSeasonState, b: TrackedSeasonState): number {
  return (
    a.title.title.localeCompare(b.title.title) ||
    a.season.seasonNumber - b.season.seasonNumber ||
    a.season.id.localeCompare(b.season.id)
  );
}
