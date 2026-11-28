import { getAgent } from '../agents.ts';
import { clearAlert, raiseAlert } from '../alerts.ts';
import { allowanceOf, allowanceViews, apiSpendSince, closeWeeks, recordProbe, SAMPLE_RETENTION_MS } from '../allowance.ts';
import { AGENT_SIZES, type AgentName, type AgentSize, type Billing, type HostView, type QueueItem, type Settings, type SyncProgress, type TicketOrder } from '../api-types.ts';
import { config } from '../config.ts';
import { all, run } from '../db.ts';
import { sweepMedia } from '../media.ts';
import { publish } from '../events.ts';
import { readClaudeLine, type ClaudeRun } from '../providers/anthropic/index.ts';
import { slotsBySize, type DockerConfig } from '../providers/docker/index.ts';
import { environmentOf, getConnection, listConnections, modelsOf, setConnectionStatus } from '../providers/index.ts';
import { appendLog, deleteLog, getRun, RUNNING_SQL, type RunRow } from '../runs.ts';
import { check } from '../http/util.ts';
import { sweepExpiredTokens } from '../http/tokens.ts';
import { getSettings } from '../settings.ts';
import { activeRunId, activeRunIds, blockersOf, vcsFor, getRepo, getTicket, isAllowedAuthor, labelsOf, openTicketsSql, priorityGraph, setBypassLimits, setPrioritised, setPush, ticketInScope, type RepoRow, type TicketRow } from '../tickets.ts';
import { agentSize, nextStep, parseLabels } from '../workflow/labels.ts';
import { AGENT_INFO } from '../workflow/prompts.ts';
import { allowanceBlock, apiCapBlock, formatTime, pickSubscription, clockTopics, dependencyBlock, freeSlot, inScope, localTime, modeBlock, place, poolFor, priorityAhead, pushEnded, startOfDay, stepPriority, withinHours, type ClockState, type HostLoad } from './gates.ts';
import { advanceMerge } from './merge.ts';
import { abortRun, cancelPause, checkRaiseRate, drive, isDriving, launch, onRunSettled, resume, switchConnection } from './runner.ts';
import { checkingBlockers, syncRepo } from './sync.ts';

const TICK_MS = 60_000;
/** How long Refresh waits for its allowance checks: a check gives up after 120 s of output, plus time to start it. */
const REFRESH_PROBE_WAIT_MS = 150_000;
const HOST_FAILURES_BEFORE_ALERT = 3;
/** Every subscription gets a reading at least this often, agents or not: the burndown learns your own use from them. */
export const IDLE_SAMPLE_MS = 60 * 60_000;
/** Close to a weekly reset readings are kept fresher, so the week's last reading is close to how it ended. */
const RESET_SAMPLE_MS = 15 * 60_000;
const RESET_WINDOW_MS = 30 * 60_000;

let lastCleanup = 0;
let clock: ClockState | null = null;
const lastSync = new Map<number, number>();
const hostFailures = new Map<number, number>();
const probing = new Map<number, ReturnType<typeof readAllowance>>();
const probeFailedAt = new Map<number, number>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `pass` one call at a time. A call made while it runs queues exactly one more run (however many
 * calls arrive), and every caller's promise resolves once the queue is drained.
 */
function serial(pass: () => Promise<void> | void): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await pass();
          } catch (err) {
            console.error('[scheduler]', err);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

export function startScheduler() {
  onRunSettled(kick);
  setInterval(() => void tick(), TICK_MS);
  void tick();
}

/** Runs an allocation pass soon, e.g. after a run ends or a setting changes. It never waits for a GitHub sync. */
export function kick() {
  setTimeout(() => void allocatePass(), 500);
}

const IDLE: SyncProgress = { state: 'idle', kind: 'scheduled', phase: null, repo: null, done: 0, total: 0, requestedAt: null, lastFinishedAt: null, lastError: null };
let progress: SyncProgress = { ...IDLE };
/** A Sync now or Refresh that no sync pass has picked up yet. */
let requested: 'sync' | 'refresh' | null = null;
/** The Refresh in flight: it owns the progress record until it ends. */
let refreshing: Promise<void> | null = null;
/** The Refresh in flight is waiting for its sync, so sync passes report to it. */
let refreshSyncing = false;

function setProgress(patch: Partial<SyncProgress>) {
  progress = { ...progress, ...patch };
  publish('sync');
}

/** What the sync is doing now (scheduled, Sync now or Refresh), and when it last finished. In memory only. */
export const syncProgress = (): SyncProgress => ({ ...progress });

/** For tests: forget the record and any pending request. */
export function resetSyncProgress() {
  progress = { ...IDLE };
  requested = null;
}

/** Records a click: waiting behind the pass that's running, or requested when none is. */
function markRequested(kind: 'sync' | 'refresh') {
  const now = Date.now();
  if (progress.state === 'running') setProgress({ state: 'waiting', kind, requestedAt: now });
  else setProgress({ state: 'requested', kind, requestedAt: now, phase: null, repo: null, done: 0, total: 0 });
  if (requested !== 'refresh') requested = kind;
}

/**
 * Fills free slots now, then syncs every repository (or right after the sync that's running) and allocates again.
 * Marks the progress record requested first; during a Refresh it joins that Refresh instead.
 */
export function syncSoon() {
  if (!refreshing) markRequested('sync');
  lastSync.clear();
  void allocatePass();
  return syncPass();
}

/**
 * Runs the checks the timer runs, now: syncs every repository, re-reads the usage of subscriptions
 * that are over their limits or unchecked (even one whose last check just failed), and allocates. A usage limit
 * Claude reported keeps its reset time. The checks start at once, and so does an allocation pass with what's
 * already startable. Waits for the sync, then (up to REFRESH_PROBE_WAIT_MS from the start) for the allowance
 * checks, then runs another allocation pass with the new readings, and resolves after it. The progress record
 * goes through the phases sync, usage and allocate. A Refresh made while one runs joins it.
 */
export function refreshNow(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = refreshOnce().finally(() => (refreshing = null));
  return refreshing;
}

async function refreshOnce() {
  markRequested('refresh');
  try {
    lastSync.clear();
    probeFailedAt.clear();
    const s = getSettings();
    const now = Date.now();
    let checked = 0;
    let counting = false;
    const checks = allowanceViews()
      .filter((a) => !a.blockedUntil && allowanceBlock(a, s, now))
      .map((a) =>
        probeAllowance(a.connectionId, true)
          .catch(() => {})
          .finally(() => {
            checked++;
            if (counting) setProgress({ done: checked });
          }),
      );
    const probed = withTimeout(Promise.all(checks), REFRESH_PROBE_WAIT_MS).catch(() => {});
    // Fill slots with what's already startable while the sync and the checks run.
    void allocatePass();
    refreshSyncing = true;
    try {
      await syncPass();
    } finally {
      refreshSyncing = false;
    }
    if (checks.length) {
      counting = true;
      setProgress({ state: 'running', phase: 'usage', repo: null, done: checked, total: checks.length });
      await probed;
      counting = false;
    }
    setProgress({ state: 'running', phase: 'allocate', repo: null, done: 0, total: 0 });
    await allocatePass(); // allocate again with the new readings (a running pass re-runs instead)
  } finally {
    setProgress({ state: 'idle', phase: null, repo: null, done: 0, total: 0, lastFinishedAt: Date.now() });
  }
}

/** Starts the best ready candidate again and again, until no ready one fits a free slot. Returns the last queue built. */
export function allocate(s: Settings, now: number): Candidate[] {
  const tried = new Set<number>();
  for (;;) {
    // Rebuilt after every start: launch() records the run at once, so host loads count the slot just taken.
    const queue = buildQueue(s, now);
    const next = queue.find((c) => !c.blockedBy && !tried.has(c.ticket.id));
    if (!next) return queue;
    tried.add(next.ticket.id);
    startCandidate(next);
  }
}

/** Local work only, no GitHub calls: re-attach, hand pushes, paused runs, filling free slots, clock topics. */
async function allocateOnce() {
  reattachRuns();
  settleManual();
  const s = getSettings();
  const now = Date.now();
  resumePaused(s, now);
  const queue = allocate(s, now);
  probeStale(queue);
  const nextClock: ClockState = {
    withinHours: withinHours(s, new Date(now)),
    // The burndown's whole points: the meters move with the line.
    blocks: JSON.stringify(allowanceViews().map((a) => [a.connectionId, a.blockedUntil, a.burndown.ceiling === null ? null : Math.floor(a.burndown.ceiling)])),
    queue: JSON.stringify(queue.map((c) => [c.ticket.id, c.blockedBy])),
  };
  for (const topic of clockTopics(clock, nextClock)) publish(topic);
  clock = nextClock;
}

/** Fills free slots from the local queue. Passes never overlap; calls during one share its single re-run. */
export const allocatePass = serial(allocateOnce);

/**
 * Syncs the repositories that are due, merges approved pull requests, then allocates with what changed.
 * Reports to the progress record when it reads a repository or answers a click. A timer pass with nothing
 * due leaves it alone, and so does a pass during a Refresh that has finished its own sync.
 */
async function syncOnce() {
  const due = dueRepos();
  const tracked = refreshing ? refreshSyncing : due.length > 0 || requested !== null;
  if (tracked) {
    const kind = refreshing ? 'refresh' : (requested ?? 'scheduled');
    requested = null;
    setProgress({ state: 'running', kind, phase: 'sync', repo: null, done: 0, total: due.length, lastError: null });
  }
  try {
    const failures = await syncRepos(due, tracked);
    if (tracked) setProgress({ repo: null, lastError: failures.join(' ') || null });
    await mergeApproved(getSettings().mode === 'paused');
    await allocatePass();
  } finally {
    // A Refresh carries on with its own phases. A click during this pass is picked up by serial's re-run.
    if (tracked && !refreshing) {
      if (requested) setProgress({ state: 'waiting' });
      else setProgress({ state: 'idle', phase: null, repo: null, done: 0, total: 0, lastFinishedAt: Date.now() });
    }
  }
}

const syncPass = serial(syncOnce);

export async function tick() {
  try {
    await checkHosts();
    if (closeWeeks(Date.now())) kick(); // a new margin moves the line, so paused runs are reconsidered
    await allocatePass();
    void syncPass(); // GitHub runs on its own: a long sync never holds allocation back
    probeIdle(Date.now());
    // Every repository, so the alert clears once the hour has passed, even after raising was turned off.
    for (const repo of all<RepoRow>('SELECT * FROM repos')) checkRaiseRate(repo);
    const now = Date.now();
    if (now - lastCleanup > 24 * 3600_000) {
      lastCleanup = now;
      await cleanup(getSettings());
    }
  } catch (err) {
    console.error('[scheduler]', err);
  }
}

/**
 * Reads every unpaused subscription whose latest reading is over an hour old, or over 15 minutes old in the half hour
 * before its weekly reset. Runs while Workshop is paused too: these are the readings your own use is learned from.
 */
export function probeIdle(now: number) {
  for (const a of allowanceViews()) {
    if (getConnection(a.connectionId)?.paused) continue;
    const age = a.sampledAt === null ? Infinity : now - a.sampledAt;
    const resetsAt = a.sevenDay?.resetsAt ?? null;
    const nearReset = resetsAt !== null && resetsAt > now && resetsAt - now <= RESET_WINDOW_MS;
    if (age > IDLE_SAMPLE_MS || (nearReset && age > RESET_SAMPLE_MS)) void probeAllowance(a.connectionId).catch(() => {});
  }
}

/** Re-reads the allowance of subscriptions that hold a launch back for want of a recent reading. */
function probeStale(queue: Candidate[]) {
  for (const c of queue) if (c.blockedBy === 'Checking allowance' && c.modelConnectionId) void probeAllowance(c.modelConnectionId).catch(() => {});
}

export function hostLoads(): (HostLoad & { name: string; specs: string | null })[] {
  const running = all<{ environment_id: number; size: AgentSize | null; slot: AgentSize | null; n: number }>(
    `SELECT environment_id, size, slot, COUNT(*) AS n FROM runs WHERE ${RUNNING_SQL} AND publish_retry_at IS NULL GROUP BY environment_id, size, slot`,
  );
  return listConnections('environment').map((c) => {
    const cfg = c.config as Partial<DockerConfig> & { specs?: string; available?: boolean };
    const slots = slotsBySize(cfg);
    const pools: HostLoad['pools'] = { standard: { slots: slots.standard, busy: 0, borrowed: 0 } };
    if (slots.small) pools.small = { slots: slots.small, busy: 0, borrowed: 0 };
    if (slots.large) pools.large = { slots: slots.large, busy: 0, borrowed: 0 };
    const host = { id: c.id, name: c.name, healthy: c.status === 'ok', available: cfg.available !== false, pools, specs: cfg.specs ?? null };
    // A run holds the pool it started in (its size's own when slot is null). A pool the host no
    // longer keeps counts as standard.
    for (const r of running) {
      if (r.environment_id !== c.id) continue;
      const pool = poolFor(host, r.slot ?? r.size ?? 'standard');
      pool.busy += r.n;
      if (pool !== poolFor(host, r.size ?? 'standard')) pool.borrowed += r.n;
    }
    return host;
  });
}

export function hostViews(): HostView[] {
  const status = new Map(listConnections('environment').map((c) => [c.id, c.status]));
  return hostLoads().map((h) => {
    const pools = AGENT_SIZES.flatMap((size) => (h.pools[size] ? [{ size, ...h.pools[size] }] : []));
    return {
      id: h.id,
      name: h.name,
      status: status.get(h.id)!,
      available: h.available,
      slots: pools.reduce((n, p) => n + p.slots, 0),
      busy: pools.reduce((n, p) => n + p.busy, 0),
      pools: pools.length > 1 ? pools : null,
      specs: h.specs,
    };
  });
}

async function checkHosts() {
  for (const c of listConnections('environment')) {
    try {
      await withTimeout(environmentOf(c).ping(), 15_000);
      hostFailures.delete(c.id);
      setConnectionStatus(c.id, 'ok');
      if (c.status !== 'ok') kick(); // a host that's back has free slots again
      clearAlert('host-offline', `host:${c.id}`);
    } catch (err) {
      const failures = (hostFailures.get(c.id) ?? 0) + 1;
      hostFailures.set(c.id, failures);
      setConnectionStatus(c.id, 'error', (err as Error).message);
      if (failures === HOST_FAILURES_BEFORE_ALERT) {
        const runs = all(`SELECT id FROM runs WHERE environment_id = ? AND ${RUNNING_SQL}`, c.id).length;
        const note = runs ? ` ${runs} agent run(s) there will be checked again when it's back.` : '';
        raiseAlert('error', 'host-offline', `Can't reach agent host ${c.name}: ${(err as Error).message}.${note}`, `host:${c.id}`);
      }
    }
  }
}

/** After a restart or a host outage, picks up runs that nothing is following any more. */
export function reattachRuns() {
  // A run waiting to publish again after a GitHub failure is picked up once it's due.
  for (const r of all<RunRow>(`SELECT * FROM runs WHERE ${RUNNING_SQL} AND (publish_retry_at IS NULL OR publish_retry_at <= ?)`, Date.now())) {
    if (!isDriving(r.id) && getConnection(r.environment_id)?.status === 'ok') void drive(r.id);
  }
}

/** The enabled repositories whose last sync is older than the poll interval. */
function dueRepos() {
  const s = getSettings();
  return all<RepoRow>('SELECT * FROM repos WHERE enabled = 1').filter((repo) => Date.now() - (lastSync.get(repo.id) ?? 0) >= s.pollMinutes * 60_000);
}

/** Syncs each repository in turn, counting them in the progress record when `track` is set. Returns the failures. */
async function syncRepos(due: RepoRow[], track: boolean) {
  const failures: string[] = [];
  for (const [i, repo] of due.entries()) {
    lastSync.set(repo.id, Date.now());
    if (track) setProgress({ repo: repo.full_name });
    try {
      await syncRepo(repo);
      clearAlert('sync-failed', `repo:${repo.id}`);
    } catch (err) {
      const message = `Couldn't sync ${repo.full_name}: ${(err as Error).message}`;
      raiseAlert('warning', 'sync-failed', message, `repo:${repo.id}`);
      failures.push(message);
    }
    if (track) setProgress({ done: i + 1 });
  }
  return failures;
}

/** Clears hand pushes that are finished or no longer eligible, and priority and limit bypasses on closed tickets. */
export function settleManual() {
  for (const t of all<TicketRow>('SELECT * FROM tickets WHERE push IS NOT NULL')) {
    const repo = getRepo(t.repo_id);
    if (!repo?.enabled || !isAllowedAuthor(t.author) || !inScope(repo.selection, labelsOf(t)) || pushEnded(t.push!, t.push_stage, labelsOf(t), t.state === 'open')) setPush(t, null);
  }
  for (const t of all<TicketRow>("SELECT * FROM tickets WHERE prioritised = 1 AND state = 'closed'")) setPrioritised(t, false);
  for (const t of all<TicketRow>("SELECT * FROM tickets WHERE bypass_limits = 1 AND state = 'closed'")) setBypassLimits(t, false);
}

/** With `pushedOnly` (Workshop is paused), only tickets you've pushed are merged. */
export async function mergeApproved(pushedOnly: boolean) {
  for (const t of all<TicketRow>(openTicketsSql)) {
    if (pushedOnly && !t.push) continue;
    const repo = getRepo(t.repo_id)!;
    if (!isAllowedAuthor(t.author) || !ticketInScope(t, repo) || nextStep(parseLabels(labelsOf(t)), true)?.kind !== 'merge' || activeRunId(t.id)) continue;
    if (blockersOf(t).length) continue; // an approved pull request waits for its blockers too
    try {
      await advanceMerge(t);
    } catch (err) {
      raiseAlert('warning', 'merge-failed', `Couldn't merge the pull request for ${getRepo(t.repo_id)?.full_name}#${t.number}: ${(err as Error).message}`, `ticket:${t.id}`);
    }
  }
}

/** Every Claude subscription in your order that isn't paused, with the models it offers and what holds it back. */
function subscriptions(s: Settings, now: number, ignoreLimits = false) {
  return listConnections('model')
    .filter((c) => !c.paused && modelsOf(c).billing().includes('subscription'))
    .map((c) => ({ id: c.id, provider: c.provider, models: modelsOf(c).models().map((m) => m.id), block: allowanceBlock(allowanceOf(c.id), s, now, ignoreLimits), failing: probeFailing(c.id, now) }));
}

/** The subscriptions that can run `model` for `provider`. The agent's own connection (`own`) counts as offering its model. */
const offering = (pool: ReturnType<typeof subscriptions>, provider: string, model: string, own?: number) =>
  pool.filter((c) => c.provider === provider && (c.id === own || c.models.includes(model)));

/**
 * Where a subscription run on a paused connection can carry on: the subscription the queue would pick for
 * its model, even one held back by your limits (the run then waits there). Null when none offers the model.
 */
function moveTarget(r: RunRow, s: Settings, now: number) {
  const conn = getConnection(r.model_connection_id);
  return conn ? pickSubscription(offering(subscriptions(s, now, bypassesLimits(r)), conn.provider, r.model)) : null;
}

/** You let this run's ticket past your subscription limits. */
const bypassesLimits = (r: RunRow) => Boolean(getTicket(r.ticket_id)?.bypass_limits);

/** Subscription runs only: the connection the run is on is paused. */
const onPausedSubscription = (r: RunRow) => r.billing === 'subscription' && Boolean(getConnection(r.model_connection_id)?.paused);

export function resumePaused(s: Settings, now: number) {
  const modeReason = modeBlock(s, new Date(now));
  const hosts = hostLoads();
  for (let r of all<RunRow>("SELECT * FROM runs WHERE status = 'paused'")) {
    if (onPausedSubscription(r)) {
      const to = moveTarget(r, s, now);
      if (to) {
        switchConnection(r.id, to.id);
        r = getRun(r.id)!;
      } else if (r.pause_reason !== 'manual') {
        // Nothing can take it over: start the stage again once a subscription can.
        const name = getConnection(r.model_connection_id)!.name;
        void abortRun(r.id, `${name} was paused and no other Claude subscription offers ${r.model}, so Workshop stopped this agent. A new one starts this stage again when a subscription is free.`);
        continue;
      }
    }
    if (r.pause_reason === 'manual') continue; // waits for you to resume it (Resume explains a paused subscription)
    // A run moving off a paused subscription was already working, so the operation mode and hours don't hold it.
    if (modeReason && r.pause_reason !== 'connection' && !getTicket(r.ticket_id)?.push) continue;
    // A threshold pause also ends early when you raise that subscription's limits: allowanceBlock below decides.
    if (r.pause_reason !== 'threshold' && r.resets_at && r.resets_at > now) continue;
    if (r.billing === 'subscription' && r.model_connection_id) {
      const block = allowanceBlock(allowanceOf(r.model_connection_id), s, now, bypassesLimits(r));
      if (block === 'Checking allowance') void probeAllowance(r.model_connection_id).catch(() => {});
      if (block) continue;
    }
    // The session and workspace live on the run's volume, so it resumes on the same host.
    const host = hosts.find((h) => h.id === r.environment_id);
    const size = r.size ?? 'standard';
    // It takes the first free pool it may use there, with no headroom check: work under way goes first.
    const slot = host?.healthy ? freeSlot(host, size) : null;
    if (!slot) continue;
    host!.pools[slot]!.busy++;
    resume(r.id, slot);
  }
}

export interface Candidate {
  ticket: TicketRow;
  repo: RepoRow;
  agent: AgentName;
  mode: 'normal' | 'delta';
  blockedBy: string | null;
  hostId: number | null;
  size: AgentSize;
  /** The host pool it starts in; a larger one than its size's when it borrows. */
  slot: AgentSize | null;
  modelConnectionId: number | null;
  model: string | null;
  billing: Billing;
  pushed: boolean;
  prioritised: boolean;
  bypassLimits: boolean;
  /** Refs of the prioritised tickets that wait on this one; it goes first for them. */
  prioritisedFor: string[];
  /** Higher-priority repositories whose queued tickets go ahead of this one. */
  after: string[];
  /** Open tickets that wait on this one, directly or through others. */
  unblocks: number;
}

function startCandidate(c: Candidate): string | null {
  return launch({
    ticketId: c.ticket.id,
    agent: c.agent,
    mode: c.mode,
    attempt: c.ticket.failures + 1,
    environmentId: c.hostId!,
    size: c.size,
    slot: c.slot!,
    modelConnectionId: c.modelConnectionId!,
    model: c.model!,
    billing: c.billing,
  });
}

/**
 * Starts an agent on one ticket now, for an explicit request. The operation mode and hours are
 * skipped (the request is the permission); every other gate still applies. Returns the run id.
 */
export function launchNow(ticketId: number): string {
  check(getTicket(ticketId), 'Ticket not found.', 404);
  const busy = 'An agent is already working on this ticket.';
  check(!activeRunId(ticketId), busy, 409);
  const c = buildQueue(getSettings(), Date.now(), { ignoreMode: true }).find((q) => q.ticket.id === ticketId);
  check(c, "There's nothing for an agent to do on this ticket right now.", 409);
  check(!c.blockedBy, `Can't start an agent yet: ${c.blockedBy}.`, 409);
  const id = startCandidate(c);
  check(id, busy, 409);
  return id;
}

/**
 * Resumes a run you paused, now. Like launchNow, the operation mode and hours are skipped; the run's
 * own host needs a free slot, and a subscription run enough allowance. On a run that hasn't stopped
 * yet, cancels the pause instead.
 */
export function resumeNow(runId: string) {
  const r = getRun(runId);
  check(r, 'Run not found.', 404);
  if (cancelPause(runId)) return;
  check(r.status === 'paused' && r.pause_reason === 'manual', 'Only a run you paused can be resumed.', 409);
  const host = hostLoads().find((h) => h.id === r.environment_id);
  const name = host?.name ?? getConnection(r.environment_id)?.name ?? 'The agent host';
  check(host, 'The agent host for this run was removed, so it can only be stopped.', 409);
  check(host.healthy, `${name} is offline. Resume this run when it's back.`, 409);
  const slot = freeSlot(host, r.size ?? 'standard');
  check(slot, `${name} has no free agent slot. Pause or stop another agent there, or resume this one when a slot frees up.`, 409);
  const s = getSettings();
  const now = Date.now();
  if (onPausedSubscription(r)) {
    const to = moveTarget(r, s, now);
    check(to, `${getConnection(r.model_connection_id)!.name} is paused and no other Claude subscription offers ${r.model}. Resume a subscription on the Connections page first.`, 409);
    switchConnection(runId, to.id);
  }
  const connectionId = getRun(runId)!.model_connection_id;
  if (r.billing === 'subscription' && connectionId) {
    const block = allowanceBlock(allowanceOf(connectionId), s, now, bypassesLimits(r));
    if (block === 'Checking allowance') void probeAllowance(connectionId).catch(() => {});
    check(!block, `Can't resume yet: ${block}.`, 409);
  }
  appendLog(runId, { step: 'workshop', stream: 'stdout', text: 'Resumed from Workshop.' });
  resume(runId, slot);
  kick();
}

// Fixed list, so the setting never reaches the SQL text.
const ORDER_SQL: Record<TicketOrder, string> = {
  'updated-asc': 't.updated_at',
  'updated-desc': 't.updated_at DESC',
  'created-asc': 'COALESCE(t.created_at, t.updated_at)',
  'created-desc': 'COALESCE(t.created_at, t.updated_at) DESC',
};

/** The repo's code host, or null when its connection is gone (the queue says so elsewhere). */
const vcsConn = (r: RepoRow) => {
  try {
    return vcsFor(r);
  } catch {
    return null;
  }
};

/** Every ticket Workshop could work on next, in order, each with the reason it's waiting (if any). */
export function buildQueue(s: Settings = getSettings(), now = Date.now(), opts: { ignoreMode?: boolean } = {}): Candidate[] {
  const hosts = hostLoads();
  const modeReason = opts.ignoreMode ? null : modeBlock(s, new Date(now));
  const spentToday = apiSpendSince(startOfDay(now, s.timezone));
  const repos = new Map(all<RepoRow>('SELECT * FROM repos').map((r) => [r.id, r]));
  const rows = all<TicketRow>(`${openTicketsSql} ORDER BY ${ORDER_SQL[s.ticketOrder] ?? ORDER_SQL['updated-asc']}, t.id`);
  const pool = subscriptions(s, now);
  // Tickets you let past your limits pick from the same subscriptions, judged without your limits.
  const bypassPool = rows.some((t) => t.bypass_limits) ? subscriptions(s, now, true) : pool;
  // A run started while GitHub is rate-limited can't publish: it would only wait, and spend more of the quota.
  const githubBlock = new Map<number, string | null>();
  for (const r of repos.values()) {
    const until = vcsConn(r)?.rateLimitedUntil?.() ?? null;
    githubBlock.set(r.id, until ? `GitHub's rate limit is used up until ${formatTime(until, s.timezone, now)}` : null);
  }
  const graph = priorityGraph();
  const active = activeRunIds();
  const out: (Candidate & { priority: number; repoPriority: number; boosted: boolean })[] = [];
  for (const t of rows) {
    const repo = repos.get(t.repo_id)!;
    if (!isAllowedAuthor(t.author) || !ticketInScope(t, repo) || active.has(t.id)) continue;
    const step = nextStep(parseLabels(labelsOf(t)), true);
    if (!step) continue;
    if (step.kind === 'merge' && t.pr_status !== 'conflict') continue; // merged through the API, no agent needed
    const agent: AgentName = step.kind === 'merge' ? 'merge' : step.agent;
    const mode = step.kind === 'merge' ? 'normal' : step.mode;
    // A ticket a prioritised ticket waits on goes first as if you'd prioritised it too.
    const prioritisedFor = graph.prioritisedFor(t, repo).map((r) => r.ref);
    const boosted = Boolean(t.prioritised) || prioritisedFor.length > 0;
    const cls = getAgent(agent);
    const conn = getConnection(cls.model_connection_id);
    const name = AGENT_INFO[agent].label;
    let blockedBy = dependencyBlock(blockersOf(t)) ?? (checkingBlockers.has(t.id) ? 'Checking what it depends on' : null) ?? githubBlock.get(repo.id) ?? (t.push ? null : modeReason);
    if (!blockedBy && (!cls.model || !conn)) blockedBy = `Choose a model for ${name} on the Agents page`;
    if (!blockedBy && !modelsOf(conn!).billing().includes(cls.billing)) {
      blockedBy = `${conn!.name} has no ${cls.billing === 'api' ? 'API key' : 'subscription token'} for ${name}`;
    }
    let useConnection = conn;
    // API-billed agents use their connection's key, paused or not: pausing only manages subscriptions.
    if (!blockedBy && cls.billing === 'api') blockedBy = apiCapBlock(spentToday, s);
    else if (!blockedBy) {
      const subs = t.bypass_limits ? bypassPool : pool;
      const pick = pickSubscription(offering(subs, conn!.provider, cls.model!, conn!.id));
      if (pick) {
        useConnection = getConnection(pick.id);
        blockedBy = pick.block;
      } else if (subs.some((c) => c.provider === conn!.provider)) blockedBy = `No Claude subscription that isn't paused offers ${cls.model}. Resume one on the Connections page`;
      else blockedBy = 'Every Claude subscription is paused. Resume one on the Connections page';
    }
    const size = agentSize(agent, parseLabels(labelsOf(t)), Boolean(t.ui));
    out.push({ ticket: t, repo, agent, mode, blockedBy, hostId: null, size, slot: null, modelConnectionId: useConnection?.id ?? null, model: cls.model, billing: cls.billing, pushed: Boolean(t.push), prioritised: Boolean(t.prioritised), bypassLimits: Boolean(t.bypass_limits), prioritisedFor, after: [], unblocks: graph.unblocks(t, repo), boosted, priority: stepPriority(step), repoPriority: repo.priority });
  }
  // Hosts come last: a borrower leaves a larger pool to a larger ready candidate that could use it.
  // allocate rebuilds the queue after every start, so the borrower gets whatever is left.
  const waiting = out.filter((c) => !c.blockedBy).map((c) => c.size);
  const hostFor = new Map(AGENT_SIZES.map((size) => [size, place(hosts, size, waiting)]));
  for (const c of out) {
    const at = hostFor.get(c.size)!;
    c.hostId = at?.hostId ?? null;
    c.slot = at?.slot ?? null;
    if (!c.blockedBy && !at) c.blockedBy = hosts.length ? 'Every agent host is busy or offline' : 'No agent hosts connected';
  }
  // Repository priority orders the queue but holds nothing back: the tick starts the first ticket that
  // fits a free slot, so a higher repo's ticket wins a slot it can use and leaves the rest to others.
  const queued = out.map((c) => ({ repo: c.repo.full_name, priority: c.repoPriority }));
  for (const c of out) if (!c.pushed && !c.boosted) c.after = priorityAhead(c.repoPriority, queued);
  // Pushed, prioritised, repository priority, then tickets more open work waits on, then step. So
  // within a repo the dependency graph decides, and across repos repository priority wins. The sort
  // is stable, so the ticket order setting (from the query) decides ties.
  return out.sort((a, b) => Number(b.pushed) - Number(a.pushed) || Number(b.boosted) - Number(a.boosted) || b.repoPriority - a.repoPriority || b.unblocks - a.unblocks || a.priority - b.priority);
}

export function queueView(): QueueItem[] {
  return buildQueue().map((c) => ({
    ticketId: c.ticket.id,
    ticket: `${c.repo.full_name}#${c.ticket.number}`,
    title: c.ticket.title,
    next: c.mode === 'delta' ? 'Re-classify requested changes' : AGENT_INFO[c.agent].label,
    blockedBy: c.blockedBy,
    push: c.ticket.push,
    prioritised: c.prioritised,
    bypassLimits: c.bypassLimits,
    prioritisedFor: c.prioritisedFor,
    after: c.after,
    unblocks: c.unblocks,
  }));
}

/**
 * Reads the subscription's 5-hour and weekly usage with the agent image's usage-probe: a one-turn
 * `claude -p` with a tiny prompt, whose first API response reports both windows. Agent runs report
 * the same thing for free, so this only runs when no recent reading exists. Fails closed.
 */
/** A removed connection's id can be reused, so its failed check mustn't carry over. */
export const forgetProbe = (connectionId: number) => probeFailedAt.delete(connectionId);

/** The last allowance check of this connection failed less than 10 minutes ago. */
const probeFailing = (connectionId: number, now: number) => now - (probeFailedAt.get(connectionId) ?? 0) < 10 * 60_000;

/** A check already running for this connection is shared: the caller gets its result. */
export function probeAllowance(connectionId: number, force = false) {
  if (!force && probeFailing(connectionId, Date.now())) return Promise.resolve(undefined);
  const running = probing.get(connectionId);
  if (running) return running;
  const pending = readAllowance(connectionId).finally(() => probing.delete(connectionId));
  probing.set(connectionId, pending);
  return pending;
}

async function readAllowance(connectionId: number) {
  const conn = getConnection(connectionId);
  if (!conn?.secret.oauthToken) throw new Error('This Claude connection has no subscription token.');
  const hosts = listConnections('environment');
  const host = hosts.find((h) => h.status === 'ok') ?? hosts[0];
  if (!host) throw new Error('Add an agent host first: Workshop checks your allowance by briefly running Claude Code on one.');
  try {
    const env = environmentOf(host);
    await env.ensureImage(config.agentImage);
    const id = await env.start({
      image: config.agentImage,
      cmd: ['usage-probe'],
      env: modelsOf(conn).launchEnv('subscription'),
      labels: { 'workshop.instance': config.instance, 'workshop.probe': String(connectionId) },
    });
    const claude: ClaudeRun = {};
    const err: string[] = [];
    let state;
    try {
      await withTimeout(env.follow(id, 0, (l) => (l.stream === 'stdout' ? readClaudeLine(claude, l.text) : err.push(l.text))), 120_000);
      state = await env.wait(id);
    } finally {
      await env.remove(id).catch(() => {}); // force-removes, so a stuck probe doesn't linger
    }
    // Some accounts answer without reporting their usage windows: it works, but the usage is unknown.
    if (!claude.usage && claude.result?.subtype === 'success' && !claude.result.isError) claude.usage = { fiveHour: null, sevenDay: null };
    if (!claude.usage) {
      const reason = claude.result?.errors.join(' ') || claude.result?.text || err.slice(-3).join(' ').trim();
      throw new Error(reason || `Claude Code didn't report usage (exit ${state.exitCode})`);
    }
    const { fiveHour, sevenDay } = claude.usage;
    recordProbe(connectionId, fiveHour, sevenDay);
    probeFailedAt.delete(connectionId);
    clearAlert('allowance-probe', `model:${connectionId}`);
    kick();
    return { fiveHour, sevenDay };
  } catch (e) {
    probeFailedAt.set(connectionId, Date.now());
    const reason = (e as Error).message.replace(/\.+$/, '');
    raiseAlert('warning', 'allowance-probe', `Couldn't read your Claude usage (${conn.name}): ${reason}. Subscription launches wait until this works.`, `model:${connectionId}`);
    throw e;
  }
}

async function cleanup(s: Settings) {
  const cutoff = Date.now() - s.retentionDays * 86400_000;
  let deleted = false;
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled', 'lost') AND ended_at < ?", cutoff)) {
    deleteLog(r.id);
    run('DELETE FROM runs WHERE id = ?', r.id);
    deleted = true;
  }
  if (deleted) publish('runs');
  // Workspaces of finished runs whose host was unreachable when they ended.
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled', 'lost') AND volume IS NOT NULL")) {
    const host = getConnection(r.environment_id);
    if (host?.status !== 'ok') continue;
    await environmentOf(host).removeVolume(r.volume!).then(
      () => run('UPDATE runs SET volume = NULL WHERE id = ?', r.id),
      () => {},
    );
  }
  sweepMedia(Date.now() - 30 * 86400_000);
  run('DELETE FROM alerts WHERE ack_at IS NOT NULL AND ack_at < ?', cutoff);
  run('DELETE FROM allowance_samples WHERE ts < ?', Date.now() - SAMPLE_RETENTION_MS);
  sweepExpiredTokens();
}
