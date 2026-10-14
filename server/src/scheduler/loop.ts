import { getAgent } from '../agents.ts';
import { clearAlert, raiseAlert } from '../alerts.ts';
import { allowanceOf, apiSpendSince, recordProbe } from '../allowance.ts';
import type { AgentName, Billing, HostView, QueueItem, Settings } from '../api-types.ts';
import { config } from '../config.ts';
import { all, run } from '../db.ts';
import { readClaudeLine, type ClaudeRun } from '../providers/anthropic/index.ts';
import { environmentOf, forgetEnvironment, getConnection, listConnections, modelsOf, setConnectionStatus, type Connection } from '../providers/index.ts';
import { deleteLog, RUNNING_SQL, type RunRow } from '../runs.ts';
import { check } from '../http/util.ts';
import { getSettings } from '../settings.ts';
import { activeRunId, blockersOf, getRepo, getTicket, isAllowedAuthor, labelsOf, setPush, type RepoRow, type TicketRow } from '../tickets.ts';
import { nextStep, parseLabels } from '../workflow/labels.ts';
import { AGENT_INFO } from '../workflow/prompts.ts';
import { allowanceBlock, apiCapBlock, dependencyBlock, localTime, modeBlock, pickHost, pushEnded, stepPriority, type HostLoad } from './gates.ts';
import { advanceMerge } from './merge.ts';
import { drive, isDriving, launch, onRunSettled, resume } from './runner.ts';
import { syncRepo } from './sync.ts';

const TICK_MS = 60_000;
const HOST_FAILURES_BEFORE_ALERT = 3;

let ticking = false;
let again = false;
let lastCleanup = 0;
const lastSync = new Map<number, number>();
const hostFailures = new Map<number, number>();
const probing = new Set<number>();
const probeFailedAt = new Map<number, number>();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function startScheduler() {
  onRunSettled(kick);
  setInterval(() => void tick(), TICK_MS);
  kick();
}

/** Runs a tick soon, e.g. after a run ends or a setting changes. */
export function kick() {
  setTimeout(() => void tick(), 500);
}

export function syncSoon() {
  lastSync.clear();
  kick();
}

export async function tick() {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    await checkHosts();
    reattachRuns();
    await syncRepos();
    settlePushes();
    const s = getSettings();
    const now = Date.now();
    await mergeApproved(s.mode === 'paused');
    resumePaused(s, now);
    const queue = buildQueue(s, now);
    const next = queue.find((c) => !c.blockedBy);
    if (next) startCandidate(next);
    for (const c of queue) if (c.blockedBy === 'Checking allowance' && c.modelConnectionId) void probeAllowance(c.modelConnectionId).catch(() => {});
    if (now - lastCleanup > 24 * 3600_000) {
      lastCleanup = now;
      await cleanup(s);
    }
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    ticking = false;
    if (again) {
      again = false;
      kick();
    }
  }
}

export function hostLoads(): (HostLoad & { name: string; specs: string | null })[] {
  const busy = new Map(
    all<{ environment_id: number; n: number }>(`SELECT environment_id, COUNT(*) AS n FROM runs WHERE ${RUNNING_SQL} GROUP BY environment_id`).map((r) => [r.environment_id, r.n]),
  );
  return listConnections('environment').map((c) => {
    const cfg = c.config as { slots?: number; specs?: string };
    return { id: c.id, name: c.name, healthy: c.status === 'ok', slots: Number(cfg.slots ?? 1), busy: busy.get(c.id) ?? 0, specs: cfg.specs ?? null };
  });
}

export function hostViews(): HostView[] {
  const status = new Map(listConnections('environment').map((c) => [c.id, c.status]));
  return hostLoads().map((h) => ({ id: h.id, name: h.name, status: status.get(h.id)!, slots: h.slots, busy: h.busy, specs: h.specs }));
}

export async function checkHosts() {
  await Promise.all(listConnections('environment').map(checkHost));
}

async function checkHost(c: Connection) {
  try {
    await withTimeout(environmentOf(c).ping(), 15_000);
    hostFailures.delete(c.id);
    setConnectionStatus(c.id, 'ok');
    clearAlert('host-offline', `host:${c.id}`);
  } catch (err) {
    // Reconnect from scratch on the next tick, so a host that comes back is found without a manual reconnect.
    forgetEnvironment(c.id);
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

/** After a restart or a host outage, picks up runs that nothing is following any more. */
function reattachRuns() {
  for (const r of all<RunRow>(`SELECT * FROM runs WHERE ${RUNNING_SQL}`)) {
    if (!isDriving(r.id) && getConnection(r.environment_id)?.status === 'ok') void drive(r.id);
  }
}

async function syncRepos() {
  const s = getSettings();
  for (const repo of all<RepoRow>('SELECT * FROM repos WHERE enabled = 1')) {
    if (Date.now() - (lastSync.get(repo.id) ?? 0) < s.pollMinutes * 60_000) continue;
    lastSync.set(repo.id, Date.now());
    try {
      await syncRepo(repo);
      clearAlert('sync-failed', `repo:${repo.id}`);
    } catch (err) {
      raiseAlert('warning', 'sync-failed', `Couldn't sync ${repo.full_name}: ${(err as Error).message}`, `repo:${repo.id}`);
    }
  }
}

const openTicketsSql = `SELECT t.* FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE r.enabled = 1 AND t.state = 'open'`;

/** Clears hand pushes that are finished, or whose repository or author is no longer eligible. */
export function settlePushes() {
  for (const t of all<TicketRow>('SELECT * FROM tickets WHERE push IS NOT NULL')) {
    const repo = getRepo(t.repo_id);
    if (!repo?.enabled || !isAllowedAuthor(t.author) || pushEnded(t.push!, t.push_stage, labelsOf(t), t.state === 'open')) setPush(t, null);
  }
}

/** With `pushedOnly` (Workshop is paused), only tickets you've pushed are merged. */
export async function mergeApproved(pushedOnly: boolean) {
  for (const t of all<TicketRow>(openTicketsSql)) {
    if (pushedOnly && !t.push) continue;
    if (!isAllowedAuthor(t.author) || nextStep(parseLabels(labelsOf(t)), true)?.kind !== 'merge' || activeRunId(t.id)) continue;
    if (blockersOf(t).length) continue; // an approved pull request waits for its blockers too
    try {
      await advanceMerge(t);
    } catch (err) {
      raiseAlert('warning', 'merge-failed', `Couldn't merge the pull request for ${getRepo(t.repo_id)?.full_name}#${t.number}: ${(err as Error).message}`, `ticket:${t.id}`);
    }
  }
}

function resumePaused(s: Settings, now: number) {
  const modeReason = modeBlock(s, new Date(now));
  const hosts = hostLoads();
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status = 'paused'")) {
    if (modeReason && !getTicket(r.ticket_id)?.push) continue;
    if (r.resets_at && r.resets_at > now) continue;
    if (r.billing === 'subscription' && r.model_connection_id) {
      const block = allowanceBlock(allowanceOf(r.model_connection_id), s, now);
      if (block === 'Checking allowance') void probeAllowance(r.model_connection_id).catch(() => {});
      if (block) continue;
    }
    // The session and workspace live on the run's volume, so it resumes on the same host.
    const host = hosts.find((h) => h.id === r.environment_id);
    if (!host?.healthy || host.busy >= host.slots) continue;
    host.busy++;
    resume(r.id);
  }
}

export interface Candidate {
  ticket: TicketRow;
  repo: RepoRow;
  agent: AgentName;
  mode: 'normal' | 'delta';
  blockedBy: string | null;
  hostId: number | null;
  modelConnectionId: number | null;
  model: string | null;
  billing: Billing;
  pushed: boolean;
}

function startCandidate(c: Candidate): string | null {
  return launch({
    ticketId: c.ticket.id,
    agent: c.agent,
    mode: c.mode,
    attempt: c.ticket.failures + 1,
    environmentId: c.hostId!,
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

export function startOfDay(now: number, timeZone: string) {
  const { minutes } = localTime(new Date(now), timeZone);
  return now - minutes * 60_000 - (now % 60_000);
}

/** Every ticket Workshop could work on next, in order, each with the reason it's waiting (if any). */
export function buildQueue(s: Settings = getSettings(), now = Date.now(), opts: { ignoreMode?: boolean } = {}): Candidate[] {
  const hosts = hostLoads();
  const hostId = pickHost(hosts);
  const modeReason = opts.ignoreMode ? null : modeBlock(s, new Date(now));
  const spentToday = apiSpendSince(startOfDay(now, s.timezone));
  const out: (Candidate & { priority: number })[] = [];
  for (const t of all<TicketRow>(`${openTicketsSql} ORDER BY t.updated_at`)) {
    if (!isAllowedAuthor(t.author) || activeRunId(t.id)) continue;
    const step = nextStep(parseLabels(labelsOf(t)), true);
    if (!step) continue;
    if (step.kind === 'merge' && t.pr_status !== 'conflict') continue; // merged through the API, no agent needed
    const agent: AgentName = step.kind === 'merge' ? 'merge' : step.agent;
    const mode = step.kind === 'merge' ? 'normal' : step.mode;
    const cls = getAgent(agent);
    const conn = getConnection(cls.model_connection_id);
    const name = AGENT_INFO[agent].label;
    let blockedBy = dependencyBlock(blockersOf(t)) ?? (t.push ? null : modeReason);
    if (!blockedBy && (!cls.model || !conn)) blockedBy = `Choose a model for ${name} on the Agents page`;
    if (!blockedBy && !modelsOf(conn!).billing().includes(cls.billing)) {
      blockedBy = `${conn!.name} has no ${cls.billing === 'api' ? 'API key' : 'subscription token'} for ${name}`;
    }
    if (!blockedBy) blockedBy = cls.billing === 'api' ? apiCapBlock(spentToday, s) : allowanceBlock(allowanceOf(conn!.id), s, now);
    if (!blockedBy && hostId === null) blockedBy = hosts.length ? 'Every agent host is busy or offline' : 'No agent hosts connected';
    out.push({ ticket: t, repo: getRepo(t.repo_id)!, agent, mode, blockedBy, hostId, modelConnectionId: conn?.id ?? null, model: cls.model, billing: cls.billing, pushed: Boolean(t.push), priority: stepPriority(step) });
  }
  return out.sort((a, b) => Number(b.pushed) - Number(a.pushed) || a.priority - b.priority);
}

export function queueView(): QueueItem[] {
  return buildQueue().map((c) => ({
    ticketId: c.ticket.id,
    ticket: `${c.repo.full_name}#${c.ticket.number}`,
    title: c.ticket.title,
    next: c.mode === 'delta' ? 'Re-classify requested changes' : AGENT_INFO[c.agent].label,
    blockedBy: c.blockedBy,
    push: c.ticket.push,
  }));
}

/**
 * Reads the subscription's 5-hour and weekly usage with the agent image's usage-probe: a one-turn
 * `claude -p` with a tiny prompt, whose first API response reports both windows. Agent runs report
 * the same thing for free, so this only runs when no recent reading exists. Fails closed.
 */
export async function probeAllowance(connectionId: number, force = false) {
  if (probing.has(connectionId)) return;
  if (!force && Date.now() - (probeFailedAt.get(connectionId) ?? 0) < 10 * 60_000) return;
  const conn = getConnection(connectionId);
  if (!conn?.secret.oauthToken) throw new Error('This Claude connection has no subscription token.');
  const hosts = listConnections('environment');
  const host = hosts.find((h) => h.status === 'ok') ?? hosts[0];
  if (!host) throw new Error('Add an agent host first: Workshop checks your allowance by briefly running Claude Code on one.');
  probing.add(connectionId);
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
  } finally {
    probing.delete(connectionId);
  }
}

async function cleanup(s: Settings) {
  const cutoff = Date.now() - s.retentionDays * 86400_000;
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled', 'lost') AND ended_at < ?", cutoff)) {
    deleteLog(r.id);
    run('DELETE FROM runs WHERE id = ?', r.id);
  }
  // Workspaces of finished runs whose host was unreachable when they ended.
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status IN ('succeeded', 'failed', 'cancelled', 'lost') AND volume IS NOT NULL")) {
    const host = getConnection(r.environment_id);
    if (host?.status !== 'ok') continue;
    await environmentOf(host).removeVolume(r.volume!).then(
      () => run('UPDATE runs SET volume = NULL WHERE id = ?', r.id),
      () => {},
    );
  }
  run('DELETE FROM alerts WHERE ack_at IS NOT NULL AND ack_at < ?', cutoff);
  run('DELETE FROM allowance_samples WHERE ts < ?', Date.now() - 8 * 86400_000);
}
