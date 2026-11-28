import crypto from 'node:crypto';
import type { AgentName, AgentSize, Billing } from '../api-types.ts';
import { getAgent, promptFor, type AgentRow } from '../agents.ts';
import { clearAlert, raiseAlert } from '../alerts.ts';
import { allowanceOf, DEFAULT_LIMITS, recordLimit, recordProbe } from '../allowance.ts';
import { config } from '../config.ts';
import { all, run } from '../db.ts';
import { publish } from '../events.ts';
import { hitUsageLimit, readClaudeLine, type ClaudeRun } from '../providers/anthropic/index.ts';
import { limitsFor, type DockerConfig } from '../providers/docker/index.ts';
import { untar } from '../providers/docker/tar.ts';
import { environmentOf, getConnection, modelsOf } from '../providers/index.ts';
import type { ContainerState, CreatedTicket, Environment, StepSpec } from '../providers/types.ts';
import { collectAgentMedia, deleteMedia, fetchTicketImages, listMedia, mediaFiles, warn, type IssueImage } from '../media.ts';
import { ACTIVE_STATUSES, activity, appendLog, getRun, linesFrom, readLog, type RunRow } from '../runs.ts';
import { getSettings } from '../settings.ts';
import { recordSpend } from '../spend.ts';
import {
  addLinks,
  branchOf,
  docPathOf,
  editLabels,
  getRepo,
  getTicket,
  blockersOf,
  handoffOf,
  isAllowedAuthor,
  labelsOf,
  linkRef,
  markRunning,
  MAX_ATTEMPTS,
  raisedOf,
  refKey,
  repoRef,
  rescueOf,
  reworkOf,
  setBlockers,
  sourceFor,
  vcsFor,
  type Raised,
  type RepoRow,
  type TicketRow,
} from '../tickets.ts';
import { imageFor, label, moveTo, parseLabels, REPO_IMAGE_DIR, repoImageTag } from '../workflow/labels.ts';
import { MAX_TICKET, replaceImageLinks, screenshotsLine } from '../workflow/media.ts';
import { AGENT_INFO, capabilitiesOf, ENVIRONMENT_LABEL, environmentText, INDEX_BODY, INDEX_PATH, protocolText, publishes, taskPrompt } from '../workflow/prompts.ts';
import { BLOCKING_AGENTS, MAX_NOTICED, parseResult, schemaFor, type AgentResult, type Handoff, type Noticed, type Rescue, type WorkResult } from '../workflow/schemas.ts';
import { bestMatch, type Similarity } from '../workflow/similar.ts';
import { planTransition, type Plan } from '../workflow/transitions.ts';
import { check } from '../http/util.ts';
import { ALLOWANCE_MAX_AGE_MS, formatTime, isRateLimited, isTransient, joinRefs, PUBLISH_GIVE_UP_MS, publishRetryMinutes, thresholdBlock } from './gates.ts';
import { advanceMerge } from './merge.ts';

// A run moves starting (prepare) → running (claude) → publishing (push + ticket updates) → succeeded.
// Each step is a container on the run's volume. Status, step and container id are persisted, so after
// a restart or a lost host Workshop re-attaches to the container and carries on from the same step.

type StepName = 'prepare' | 'run' | 'publish';

class HostUnreachable extends Error {}

const USAGE_RECORD_MS = 30_000;
/** How long a run over its subscription's limits may wait for its open tool calls (a long subagent) before it's stopped anyway. */
export const PAUSE_GRACE_MS = 10 * 60_000;
const driving = new Set<string>();
export const isDriving = (id: string) => driving.has(id);
/** Running agents' "a pause was just requested" callbacks, so a request acts at once when the agent is between turns. */
const pauseSignals = new Map<string, () => void>();

let settled = () => {};
/**
 * Called whenever a run frees its slot: its containers exit or it fails, publishes, pauses, waits to publish again
 * or is cancelled. The scheduler uses it to look for the next job. Not called when only the host is out of reach.
 */
export function onRunSettled(fn: () => void) {
  settled = fn;
}

function setRun(id: string, fields: Partial<Record<keyof RunRow, string | number | null>>) {
  const keys = Object.keys(fields) as (keyof RunRow)[];
  run(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k] ?? null), id);
  publish('runs');
}

interface Ctx {
  run: RunRow;
  ticket: TicketRow;
  repo: RepoRow;
  env: Environment;
  host: { name: string; cfg: DockerConfig };
  image: string;
  labels: Record<string, string>;
}

function context(r: RunRow): Ctx {
  const ticket = getTicket(r.ticket_id);
  if (!ticket) throw new Error('The ticket no longer exists in Workshop.');
  const repo = getRepo(ticket.repo_id)!;
  const conn = getConnection(r.environment_id);
  if (!conn) throw new Error('The agent host for this run was removed.');
  return {
    run: r,
    ticket,
    repo,
    env: environmentOf(conn),
    host: { name: conn.name, cfg: conn.config as unknown as DockerConfig },
    image: r.image ?? imageFor(r.agent, parseLabels(labelsOf(ticket)), { repo: repo.image || null, base: config.agentImage, browser: config.agentBrowserImage }, Boolean(ticket.ui)),
    labels: { 'workshop.instance': config.instance, 'workshop.run': r.id, 'workshop.ticket': `${repo.full_name}#${ticket.number}`, 'workshop.agent': r.agent },
  };
}

const builds = new Map<string, Promise<void>>();

/**
 * The image for a new run. A repository with `.workshop/Dockerfile` on its default branch (and no
 * hand-set image) gets that Dockerfile built on the standard image this run would otherwise use.
 * Problems with it fall back to the standard image, so a broken Dockerfile never stops work.
 */
async function chooseImage(ctx: Ctx): Promise<string> {
  const standard = ctx.image;
  if (ctx.repo.image) return standard;
  const r = ctx.run;
  const name = `${ctx.repo.full_name}'s ${REPO_IMAGE_DIR}/Dockerfile`;
  try {
    const files = await vcsFor(ctx.repo).readFolder(repoRef(ctx.repo), ctx.repo.default_branch, REPO_IMAGE_DIR);
    if (!files?.Dockerfile) return standard;
    await ctx.env.ensureImage(standard);
    const tag = repoImageTag(ctx.repo.id, files, (await ctx.env.imageId(standard)) ?? standard);
    if (!(await ctx.env.imageId(tag))) {
      // Runs on the same host share one build of the same tag.
      const key = `${r.environment_id}:${tag}`;
      if (!builds.has(key)) {
        appendLog(r.id, { step: 'workshop', stream: 'stdout', text: `Building the agent image from ${name}` });
        const build = ctx.env.build({
          tag,
          files,
          args: { WORKSHOP_BASE: standard },
          labels: { 'workshop.instance': config.instance, 'workshop.repo': ctx.repo.full_name },
          onLine: (text) => appendLog(r.id, { step: 'workshop', stream: 'stdout', text }),
        });
        builds.set(key, build.finally(() => builds.delete(key)));
      }
      await builds.get(key);
    }
    clearAlert('repo-image', `repo:${ctx.repo.id}`);
    return tag;
  } catch (err) {
    const message = `Couldn't use ${name}, so agents use the standard image: ${(err as Error).message}`;
    warn(r.id, message);
    raiseAlert('warning', 'repo-image', `${message} The run log has the details.`, `repo:${ctx.repo.id}`);
    return standard;
  }
}

/** Starts (or re-attaches to) the container for one step, streams its log, and waits for it to exit. */
async function runContainer(
  ctx: Ctx,
  step: StepName,
  makeSpec: () => Promise<Pick<StepSpec, 'cmd' | 'env' | 'files'>>,
  onStdout?: (text: string, replayed: boolean) => void,
  timeoutMs?: number,
): Promise<ContainerState & { timedOut: boolean }> {
  let id = ctx.run.step === step ? ctx.run.container_id : null;
  if (id && !(await ctx.env.inspect(id))) {
    if (step === 'run') throw new Error('The agent container disappeared (was the host restarted?).');
    id = null; // prepare and publish are safe to repeat
  }
  const reattached = Boolean(id);
  if (!id) {
    const spec = await makeSpec();
    const limits = limitsFor(ctx.host.cfg, ctx.run.size ?? 'standard');
    await ctx.env.ensureImage(ctx.image);
    id = await ctx.env.start({
      ...spec,
      image: ctx.image,
      volume: ctx.run.volume ?? undefined,
      labels: { ...ctx.labels, 'workshop.step': step },
      cpus: limits.cpus,
      memoryMb: limits.memoryGb ? Math.round(limits.memoryGb * 1024) : undefined,
    });
    const startedAt = Date.now();
    setRun(ctx.run.id, { step, container_id: id, step_started_at: startedAt });
    Object.assign(ctx.run, { step, container_id: id, step_started_at: startedAt });
  }
  const containerId = id;
  const short = id.slice(0, 12);
  if (reattached && onStdout) for (const e of readLog(ctx.run.id)) if (e.container === short && e.stream === 'stdout') onStdout(e.text, true);
  let timedOut = false;
  // After a re-attach, only the time left counts: the limit runs from when the container started.
  const started = ctx.run.step_started_at;
  const left = timeoutMs && reattached && started != null ? Math.max(0, timeoutMs - (Date.now() - started)) : timeoutMs;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        void ctx.env.kill(containerId);
      }, left)
    : undefined;
  try {
    await ctx.env.follow(containerId, reattached ? linesFrom(ctx.run.id, short) : 0, (line) => {
      appendLog(ctx.run.id, { step, stream: line.stream, text: line.text, container: short });
      if (line.stream === 'stdout') onStdout?.(line.text, false);
    });
    const state = await ctx.env.wait(containerId);
    await ctx.env.remove(containerId);
    return { ...state, timedOut };
  } catch (err) {
    const reachable = await ctx.env.ping().then(() => true, () => false);
    if (!reachable) throw new HostUnreachable(`Lost contact with ${ctx.host.name} during the ${step} step.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function prepareSpec(ctx: Ctx) {
  const access = await vcsFor(ctx.repo).gitAccess(repoRef(ctx.repo), false);
  return {
    cmd: ['prepare'],
    env: {
      REPO_URL: access.url,
      CLEAN_URL: access.cleanUrl,
      BRANCH: branchOf(ctx.ticket),
      BASE_BRANCH: ctx.repo.default_branch,
      GIT_NAME: access.name,
      GIT_EMAIL: access.email,
    },
  };
}

async function runSpec(ctx: Ctx, agent: AgentRow) {
  const r = ctx.run;
  const model = getConnection(r.model_connection_id);
  if (!model) throw new Error('The Claude connection for this run was removed.');
  const env: Record<string, string> = {
    ...modelsOf(model).launchEnv(r.billing),
    MODEL: r.model,
    SESSION_ID: r.id,
    EFFORT: agent.effort ?? '',
    MAX_TURNS: String(r.max_turns ?? agent.max_turns),
    MAX_BUDGET_USD: r.billing === 'api' ? String(getSettings().apiRunCapUsd) : '',
    RESUME: r.resumes > 0 ? '1' : '',
  };
  const blockers = mayRaiseBlockers(ctx.repo, ctx.ticket, r.agent);
  const files: Record<string, string | Buffer> = {
    '.workshop/': '',
    '.workshop/schema.json': JSON.stringify(schemaFor(r.agent, { noticed: mayRaise(ctx.repo, ctx.ticket, r.agent), blockers })),
  };
  if (r.resumes === 0) {
    const t = ctx.ticket;
    const repo = repoRef(ctx.repo);
    const source = sourceFor(ctx.repo);
    const labels = labelsOf(t);
    // Each batch of images is downloaded right after the fetch that returned it: GitHub's signed links expire in minutes.
    try {
      await fetchTicketImages(r.id, t.id, (await source.ticketImages(repo, t.number)).map((ref) => ({ source: 'issue', ref })));
    } catch (err) {
      warn(r.id, `Workshop skipped the images in the issue: ${(err as Error).message}`);
    }
    const comments = await source.comments(repo, t.number);
    const included = comments.filter((c) => isAllowedAuthor(c.author) || c.author === source.selfLogin());
    await fetchTicketImages(r.id, t.id, included.flatMap((c) => (c.images ?? []).map((ref): IssueImage => ({ source: 'comment', ref }))));
    const review = t.pr_number && r.agent !== 'merge' ? await vcsFor(ctx.repo).reviewFeedback(repo, t.pr_number, getSettings().authors) : [];
    await fetchTicketImages(r.id, t.id, review.flatMap((c) => (c.images ?? []).map((ref): IssueImage => ({ source: 'comment', ref }))));
    const stored = listMedia(t.id);
    const byKey = new Map(stored.filter((m) => m.source_key).map((m) => [m.source_key!, m.name]));
    const local = (text: string) => replaceImageLinks(text, byKey);
    const branch = branchOf(t);
    const docPath = docPathOf(t);
    const rescue = rescueOf(t);
    // The Classifier sees the most recent in its prompt; it and agents that may raise prerequisites get all of them in the index.
    const indexed = r.agent === 'classifier' || (blockers && BLOCKING_AGENTS.includes(r.agent));
    const open = indexed
      ? all<{ number: number; title: string; body: string; author: string; labels: string }>(
          "SELECT number, title, body, author, labels FROM tickets WHERE repo_id = ? AND state = 'open' AND id != ? ORDER BY updated_at DESC",
          ctx.repo.id,
          t.id,
        ).filter((o) => isAllowedAuthor(o.author))
      : [];
    if (indexed) {
      files[INDEX_PATH.replace('/work/', '')] = open
        .map((o) => JSON.stringify({ number: o.number, title: o.title, labels: JSON.parse(o.labels), body: o.body.slice(0, INDEX_BODY) }) + '\n')
        .join('');
    }
    const openTickets = r.agent === 'classifier' ? open : undefined;
    const imageLabels: Record<string, string> = await ctx.env.imageLabels(ctx.image).catch(() => ({}));
    const environment = environmentText(capabilitiesOf(imageLabels), imageLabels[ENVIRONMENT_LABEL]);
    files['.workshop/system.md'] = `${promptFor(agent)}\n\n${protocolText({ branch, base: ctx.repo.default_branch, publishes: publishes(r.agent), noticed: mayRaise(ctx.repo, t, r.agent), blockers: blockers && BLOCKING_AGENTS.includes(r.agent) })}\n\n${environment}`;
    files['.workshop/prompt.md'] = taskPrompt({
      agent: r.agent,
      mode: r.mode,
      repo: ctx.repo.full_name,
      base: ctx.repo.default_branch,
      branch,
      docPath,
      ticket: { number: t.number, title: t.title, body: local(t.body), url: t.url, labels, size: parseLabels(labels).size },
      comments: included.map((c) => ({ ...c, body: local(c.body) })),
      omittedComments: comments.length - included.length,
      review: review.map((x) => ({ ...x, body: local(x.body) })),
      openTickets,
      indexed: indexed ? open.length : undefined,
      raiseBlockers: blockers && r.agent === 'classifier',
      ui: Boolean(t.ui),
      media: stored.map((m) => ({ name: m.name, source: m.source, runId: m.run_id, caption: m.caption })),
      rescue: r.agent === 'merge' && parseLabels(labels).stage === 'reconcile' && rescue ? { branch: rescue.branch, agent: rescue.agent, summary: rescue.result.summary } : undefined,
      rework: reworkOf(t) ?? undefined,
    });
    Object.assign(files, mediaFiles(t.id));
  }
  return { cmd: ['run'], env, files };
}

async function publishSpec(ctx: Ctx) {
  const access = await vcsFor(ctx.repo).gitAccess(repoRef(ctx.repo), true);
  return {
    cmd: ['publish'],
    env: { PUSH_URL: access.url, BRANCH: branchOf(ctx.ticket), BASE_BRANCH: ctx.repo.default_branch, GIT_NAME: access.name, GIT_EMAIL: access.email },
  };
}

function describeError(res: NonNullable<ClaudeRun['result']>, maxTurns: number): string {
  switch (res.subtype) {
    case 'error_max_turns':
      return `Reached the ${maxTurns}-turn limit.`;
    case 'error_max_budget_usd':
      return `Reached the $${getSettings().apiRunCapUsd} per-run API budget.`;
    case 'error_max_structured_output_retries':
      return "Couldn't produce a valid structured result.";
    default:
      return res.errors.join('; ') || res.text || 'Claude Code reported an error.';
  }
}

const summarize = (r: AgentResult) => {
  if (!('decision' in r)) return r.summary;
  const what =
    r.decision === 'accept'
      ? `Sized ${r.size?.toUpperCase()}`
      : r.decision === 'reject'
        ? 'Declined'
        : r.decision === 'blocked'
          ? `Waiting for ${joinRefs([
              ...(r.blocked_by ?? []).map((n) => `#${n}`),
              ...(r.raise_blockers?.length ? [`${r.raise_blockers.length} new ticket${r.raise_blockers.length === 1 ? '' : 's'}`] : []),
            ])}`
          : 'Asked questions';
  return `${what}: ${r.reason}`;
};

/** Copies the images an agent left in /work/media into the ticket's store. Problems are run warnings, never failures. */
async function copyBackMedia(ctx: Ctx, parsed: AgentResult) {
  const r = ctx.run;
  if (!r.volume) return;
  try {
    const archive = await ctx.env.readArchive({ image: ctx.image, volume: r.volume, path: '/work/media', labels: ctx.labels, maxBytes: 2 * MAX_TICKET });
    if (!archive) return;
    const captions = new Map<string, string>();
    for (const m of 'media' in parsed ? (parsed.media ?? []) : []) captions.set(m.path.split('/').pop()!, m.caption);
    collectAgentMedia(r.id, r.ticket_id, AGENT_INFO[r.agent].label, untar(archive), captions);
  } catch (err) {
    warn(r.id, `Workshop couldn't copy /work/media into the ticket's store: ${(err as Error).message}`);
  }
}

/** The claude step. Returns true when the run should go on to publishing. */
async function runAgent(ctx: Ctx): Promise<boolean> {
  const r = ctx.run;
  const agent = getAgent(r.agent);
  const name = AGENT_INFO[r.agent].label;
  const claude: ClaudeRun = {};
  let lastPublished = 0;
  let recorded = '';
  let recordedAt = 0;
  const recordUsage = () => {
    if (!claude.usage || r.billing !== 'subscription' || !r.model_connection_id) return;
    const reading = JSON.stringify(claude.usage);
    if (reading === recorded) return;
    recorded = reading;
    recordedAt = Date.now();
    recordProbe(r.model_connection_id, claude.usage.fiveHour, claude.usage.sevenDay);
  };
  // Over its subscription's limits: judged on this run's own reading and the account's latest fresh one,
  // which other runs and probes keep current.
  const overThreshold = () => {
    if (r.billing !== 'subscription' || claude.result) return null;
    if (getTicket(r.ticket_id)?.bypass_limits) return null; // you let this ticket past your limits
    const s = getSettings();
    const now = Date.now();
    const stored = r.model_connection_id ? allowanceOf(r.model_connection_id) : null;
    const limits = stored?.limits ?? DEFAULT_LIMITS;
    const own = claude.usage ? thresholdBlock(claude.usage, limits, s, now) : null;
    if (own || !stored) return own;
    return stored.sampledAt && now - stored.sampledAt <= ALLOWANCE_MAX_AGE_MS ? thresholdBlock(stored, limits, s, now) : null;
  };
  // Why the agent should stop at the next turn boundary, if it should. A pause you asked for wins, then a
  // paused subscription (the tick moves the run to another one).
  type PauseFor = { kind: 'manual' | 'connection' | 'threshold'; reason: string; resetsAt: number | null };
  const wantPause = (): PauseFor | null => {
    if (claude.result) return null;
    if (getRun(r.id)?.pause_requested_at) return { kind: 'manual', reason: 'you paused it', resetsAt: null };
    const conn = r.billing === 'subscription' ? getConnection(r.model_connection_id) : undefined;
    if (conn?.paused) return { kind: 'connection', reason: `${conn.name} was paused`, resetsAt: null };
    const over = overThreshold();
    return over && { kind: 'threshold', ...over };
  };
  // Set once Workshop stops the agent; the run then pauses instead of failing.
  let pausedFor = null as PauseFor | null;
  let grace: NodeJS.Timeout | undefined;
  const pause = (why: PauseFor) => {
    clearTimeout(grace);
    pausedFor = why;
    activity.set(r.id, `Pausing: ${why.reason}.`);
    publish('runs');
    const id = getRun(r.id)?.container_id;
    if (id) void ctx.env.kill(id).catch(() => {});
  };
  const startGrace = () => {
    grace = setTimeout(() => {
      grace = undefined;
      const still = wantPause(); // null once the result is in, usage is back under, or you said keep working
      if (still) pause(still);
    }, PAUSE_GRACE_MS);
  };
  pauseSignals.set(r.id, () => {
    if (pausedFor) return;
    const want = wantPause();
    if (want && claude.boundary) pause(want);
    else if (want && claude.openTools?.length && !grace) startGrace();
    // Otherwise the agent is mid-reply, and its next line decides.
  });
  // Set while this segment continues a session another subscription started, until its first turn boundary.
  let switched = r.switched_from !== null;
  let trailing: NodeJS.Timeout | undefined;
  // A new session records the limits it starts with; a re-attach keeps the ones it has.
  if (!(r.step === 'run' && r.container_id)) {
    setRun(r.id, { max_turns: agent.max_turns, timeout_min: agent.timeout_min });
    Object.assign(r, { max_turns: agent.max_turns, timeout_min: agent.timeout_min });
  }
  const maxTurns = r.max_turns ?? agent.max_turns;
  const timeoutMin = r.timeout_min ?? agent.timeout_min;
  const running = runContainer(
    ctx,
    'run',
    () => runSpec(ctx, agent),
    (text, replayed) => {
      const before = claude.activity;
      const hadResult = !!claude.result;
      readClaudeLine(claude, text);
      if (switched && claude.boundary) {
        switched = false;
        setRun(r.id, { switched_from: null });
      }
      // Every run reports current subscription usage: a free, fresh reading for the allowance gate and
      // the usage bars. Recorded whenever it changes, at most every 30 seconds.
      if (!replayed && Date.now() - recordedAt >= USAGE_RECORD_MS) recordUsage();
      // Stop only where a turn ends, so no tool is cut off half-way. Lines replayed after a re-attach are history.
      if (!replayed && !pausedFor && (claude.boundary || !grace)) {
        const want = wantPause();
        if (want && claude.boundary) pause(want);
        else if (want && claude.openTools?.length) startGrace();
        else if (!want && claude.boundary) {
          clearTimeout(grace);
          grace = undefined;
        }
      }
      if (claude.result && !hadResult) {
        // Say what the log says, the moment it says it: the container may take a while to exit.
        activity.set(r.id, claude.result.isError ? 'The agent stopped with an error.' : 'The agent finished.');
        clearTimeout(trailing);
        trailing = undefined;
        lastPublished = Date.now();
        publish('runs');
      } else if (claude.activity && claude.activity !== before) {
        activity.set(r.id, claude.activity);
        // Throttled, but never drop the latest change: a trailing publish catches up once the window ends.
        const wait = lastPublished + 3000 - Date.now();
        if (wait <= 0) {
          lastPublished = Date.now();
          publish('runs');
        } else if (!trailing) {
          trailing = setTimeout(() => {
            trailing = undefined;
            lastPublished = Date.now();
            publish('runs');
          }, wait);
        }
      }
    },
    timeoutMin * 60_000,
  );
  // Record what the run reported even if the container failed.
  const state = await running.finally(() => {
    clearTimeout(grace);
    pauseSignals.delete(r.id);
    recordUsage();
  });
  clearTimeout(trailing);
  activity.delete(r.id);
  publish('runs');
  if (getRun(r.id)!.status !== 'running') return false; // stopped while it ran
  const res = claude.result;
  setRun(r.id, { exit_code: state.exitCode });
  if (res) recordSpend(r, res);

  if (claude.limit && r.model_connection_id) recordLimit(r.model_connection_id, claude.limit.resetsAt ?? Date.now() + 3600_000);
  if (pausedFor && res?.structured === undefined) {
    // Killed between turns, so the session resumes cleanly. A killed segment prints no result, so its
    // tokens and cost don't reach the spend ledger: acceptable for subscription runs, an undercount for
    // API runs you pause by hand (see docs/workshop/80-feature-manual-pause.md).
    setRun(r.id, { status: 'paused', step: 'run', container_id: null, resets_at: pausedFor.resetsAt, pause_reason: pausedFor.kind, pause_requested_at: null });
    await markRunning(ctx.ticket, false);
    return false;
  }
  if (state.oomKilled) {
    raiseAlert('warning', 'container-killed', `${ctx.labels['workshop.ticket']}: the ${name} agent ran out of memory on ${ctx.host.name}.`, `run:${r.id}`);
    const size = r.size ?? 'standard';
    throw new Error(`Ran out of memory (limit ${limitsFor(ctx.host.cfg, size).memoryGb ?? '?'} GB per ${size} agent on ${ctx.host.name}).`);
  }
  if (hitUsageLimit(claude)) {
    setRun(r.id, { status: 'paused', step: 'run', container_id: null, resets_at: claude.limit?.resetsAt ?? Date.now() + 3600_000, pause_reason: 'limit' });
    await markRunning(ctx.ticket, false);
    return false;
  }
  if (switched && (!res || res.isError)) {
    // The session didn't get going on the subscription it moved to: start the stage again instead of failing.
    await abortRun(r.id, `Couldn't continue the session on ${getConnection(r.model_connection_id)?.name ?? 'the new subscription'}, so Workshop starts this stage again.`);
    return false;
  }
  if (claude.apiError === 'authentication_failed') {
    raiseAlert('error', 'claude-auth', 'Claude rejected the credentials Workshop used. For a subscription, run "claude setup-token" again and update the Claude connection.', `model:${r.model_connection_id}`);
  }
  if (!res) {
    if (state.timedOut) throw new Error(`Stopped after the ${timeoutMin}-minute time limit.`);
    if (state.exitCode === 137 || state.exitCode === 143) {
      raiseAlert('warning', 'container-killed', `${ctx.labels['workshop.ticket']}: the ${name} container was killed on ${ctx.host.name} (exit ${state.exitCode}).`, `run:${r.id}`);
    }
    throw new Error(`Claude Code exited (code ${state.exitCode}) without a result. See the run log.`);
  }
  if (res.isError) throw new Error(describeError(res, maxTurns));
  const parsed = parseResult(r.agent, res.structured);
  if (typeof parsed === 'string') throw new Error(`The agent's result was invalid: ${parsed}`);
  await copyBackMedia(ctx, parsed);
  setRun(r.id, { status: 'publishing', step: null, container_id: null, result: JSON.stringify(parsed), summary: summarize(parsed), pause_requested_at: null });
  return true;
}

/** What the publish step reports: the branch before and after the push, and commits ahead of base. */
interface Pushed {
  before?: string;
  after?: string;
  ahead?: number;
  /** Set when the branch moved and the agent's commits conflict: the branch they were saved on. */
  rescued?: string;
}

/**
 * Opens the pull request, or comments on the one under review, with the Implementation summary in
 * `handoff` and the code review's notes (first when `flagged`: severe problems remain).
 */
async function openOrUpdatePr(ctx: Ctx, t: TicketRow, handoff: Handoff, reviewNotes = '', flagged = false) {
  const repo = repoRef(ctx.repo);
  const vcs = vcsFor(ctx.repo);
  const branch = branchOf(t);
  const result = handoff.result;
  const tests = result.tests ? `\n\n**Tests:** ${result.tests}` : '';
  // Only a recorded PR means "update after review". One opened but never recorded (a retried request, a
  // restart) goes through openPullRequest, which takes it over.
  let number = t.pr_number;
  let url = t.pr_url;
  const shots = screenshotsLine(listMedia(t.id).filter((m) => m.run_id === handoff.runId), config.publicUrl, t.id);
  const screenshots = shots ? `\n\n${shots}` : '';
  const notes = reviewNotes ? `\n\n${reviewNotes}` : '';
  if (number) {
    // After a review, no new commits is a valid answer: the review may only ask to re-run the tests or
    // explain something, so the summary goes to the reviewer.
    const head = handoff.before === handoff.after ? 'Reviewed again with no code changes.' : 'Updated after review.';
    const work = `${result.summary}${tests}${screenshots}`;
    await vcs.commentOnPullRequest(repo, number, flagged ? `${head}${notes}\n\n${work}` : `${head}\n\n${work}${notes}`);
  } else {
    const size = parseLabels(labelsOf(t)).size;
    const design = size === 'm' || size === 'l' || size === 'xl' ? `\n\n**Design:** [\`${docPathOf(t)}\`](${vcs.fileUrl(repo, branch, docPathOf(t))})` : '';
    const work = `${result.summary}${tests}${screenshots}${design}`;
    const described = flagged && reviewNotes ? `${reviewNotes}\n\n${work}` : `${work}${notes}`;
    const body = `${described}\n\nCloses #${t.number}\n\n---\n_Opened by Workshop. Approve to merge it, or request changes and Workshop will work on them._`;
    const pr = await vcs.openPullRequest(repo, { branch, title: t.title, body });
    number = pr.number;
    url = pr.url;
  }
  run("UPDATE tickets SET pr_number = ?, pr_url = ?, pr_status = 'review' WHERE id = ?", number, url, t.id);
}

/**
 * What a publish has decided and done so far, stored on the run. A retry after a temporary GitHub failure
 * reuses the plan (the labels, rework and rescue it was made from may have changed since) and skips the
 * steps that finished, so nothing is posted twice.
 */
interface PublishState {
  plan: Plan;
  /** The ticket's labels the plan was made from. */
  labels: string[];
  pushed?: Pushed;
  done: string[];
  /** The prerequisite tickets the blockers step linked, for the comment of a retry. */
  prerequisites?: Prerequisite[];
}

/**
 * Whether this run may report work outside its ticket. Not the Classifier, which only sizes; and not on a ticket
 * that was itself opened this way, so noticed work can't keep spawning more.
 */
const mayRaise = (repo: RepoRow, t: TicketRow, agent: AgentName) => Boolean(repo.raise_tickets) && agent !== 'classifier' && !labelsOf(t).includes(label.raised);

/**
 * Whether this run may open prerequisite tickets its ticket waits for: the Classifier and `BLOCKING_AGENTS`, under the
 * same setting, and again not on a ticket that was itself raised, so prerequisites can't chain.
 */
const mayRaiseBlockers = (repo: RepoRow, t: TicketRow, agent: AgentName) =>
  Boolean(repo.raise_tickets) && (agent === 'classifier' || BLOCKING_AGENTS.includes(agent)) && !labelsOf(t).includes(label.raised);

/**
 * Stores a ticket Workshop just opened from what the reply already holds, so other runs see it, in the open-ticket
 * index and as a similarity candidate, before the next sync. No extra request; the sync later updates it as usual.
 * Left to the sync if it already has it, and skipped, as the sync would, if Workshop isn't an allowed author.
 */
function storeCreated(repo: RepoRow, made: CreatedTicket, t: { title: string; body: string; labels: string[] }) {
  const author = made.author ?? sourceFor(repo).selfLogin();
  if (!isAllowedAuthor(author)) return;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tickets (repo_id, number, node_id, title, body, url, author, state, labels, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (repo_id, number) DO NOTHING`,
    repo.id,
    made.number,
    made.nodeId ?? null,
    t.title,
    t.body,
    made.url,
    author,
    JSON.stringify(t.labels),
    made.updatedAt ?? now,
    made.createdAt ?? now,
  );
}

const sameTitle = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const MAX_RAISED_TITLE = 200;
const MAX_RAISED_BODY = 20_000;

/**
 * Opens a ticket for each thing the agent noticed outside its ticket, and returns the ones this run opened.
 * Each is recorded as soon as it exists, so a publish retried after a GitHub failure doesn't open it twice; one
 * whose title an open ticket (or an earlier run on this ticket) already has is left out.
 */
async function raiseNoticed(ctx: Ctx, t: TicketRow, result: AgentResult): Promise<Raised[]> {
  const r = ctx.run;
  const noticed = (result as WorkResult).noticed ?? [];
  if (!noticed.length || !mayRaise(ctx.repo, t, r.agent)) return [];
  const source = sourceFor(ctx.repo);
  for (const n of noticed.slice(0, MAX_NOTICED)) {
    const title = n.title.trim().replace(/\s+/g, ' ').slice(0, MAX_RAISED_TITLE);
    const before = raisedOf(getTicket(t.id)!);
    const open = all<{ title: string }>("SELECT title FROM tickets WHERE repo_id = ? AND state = 'open'", t.repo_id);
    if ([...before, ...open].some((x) => sameTitle(x.title, title))) continue;
    const body = `${n.body.trim().slice(0, MAX_RAISED_BODY)}\n\n---\n_Workshop's ${AGENT_INFO[r.agent].label} agent noticed this while working on #${t.number}. It's outside that ticket, so nothing was changed for it there._`;
    const made = await source.createTicket(repoRef(ctx.repo), { title, body, labels: [label.raised] });
    storeCreated(ctx.repo, made, { title, body, labels: [label.raised] });
    run('UPDATE tickets SET raised = ? WHERE id = ?', JSON.stringify([...before, { number: made.number, url: made.url, title, runId: r.id, at: Date.now() }]), t.id);
    checkRaiseRate(ctx.repo);
  }
  // Prerequisites are listed on their own.
  return raisedOf(getTicket(t.id)!).filter((x) => x.runId === r.id && !x.blocker);
}

interface Prerequisite {
  number: number;
  title: string;
  /** An open ticket that already had this title, rather than one Workshop opened. */
  existing: boolean;
  /** Linked because it is similar to this proposed title, rather than the same. */
  instead?: string;
}

const score = (s: Similarity) => `title ${s.title.toFixed(2)} with ${s.shared} shared keyword${s.shared === 1 ? '' : 's'}, text ${s.text.toFixed(2)}`;

/**
 * Opens (or finds) a ticket for each prerequisite the agent says its ticket waits for. A prerequisite this ticket
 * already raised with the same title, in this run or an earlier one, is reused, so a retried publish or a stage
 * run again doesn't open it twice; so is an open ticket with the same title. Each new one is recorded as soon as it exists.
 */
async function raiseBlockers(ctx: Ctx, t: TicketRow, wanted: Noticed[], agent: AgentName): Promise<Prerequisite[]> {
  const r = ctx.run;
  // The setting as it is now: it may have been turned off since the run started.
  if (!mayRaiseBlockers(getRepo(ctx.repo.id) ?? ctx.repo, t, agent)) return [];
  const source = sourceFor(ctx.repo);
  const made: Prerequisite[] = [];
  for (const n of wanted.slice(0, MAX_NOTICED)) {
    const title = n.title.trim().replace(/\s+/g, ' ').slice(0, MAX_RAISED_TITLE);
    const before = raisedOf(getTicket(t.id)!);
    // A prerequisite first, else a ticket noticed earlier that may not be synced yet.
    const earlier = before.find((x) => x.blocker && sameTitle(x.title, title)) ?? before.find((x) => sameTitle(x.title, title));
    if (earlier) {
      made.push({ number: earlier.number, title: earlier.title, existing: false });
      continue;
    }
    const others = all<TicketRow>("SELECT * FROM tickets WHERE repo_id = ? AND state = 'open' AND id != ?", t.repo_id, t.id);
    const open = others.find((x) => sameTitle(x.title, title));
    if (open) {
      made.push({ number: open.number, title: open.title, existing: true });
      continue;
    }
    // A similar open prerequisite-type ticket (one agents raised, including any opened moments ago by another run), or
    // one raised here, is linked instead. Not one that waits for this ticket: that would be a cycle. Only local data: no GitHub requests.
    const self = refKey(`#${t.number}`, ctx.repo.full_name);
    const closed = new Set(all<{ number: number }>("SELECT number FROM tickets WHERE repo_id = ? AND state != 'open'", t.repo_id).map((x) => x.number));
    const candidates = [
      ...others
        .filter((o) => labelsOf(o).includes(label.raised) && isAllowedAuthor(o.author) && !blockersOf(o).some((b) => refKey(b, ctx.repo.full_name) === self))
        .map((o) => ({ number: o.number, title: o.title, body: o.body })),
      ...before.filter((x) => x.number !== t.number && !closed.has(x.number)).map((x) => ({ number: x.number, title: x.title, body: '' })),
    ];
    const similar = bestMatch({ title, body: n.body }, candidates);
    if (similar) {
      const m = similar.match;
      appendLog(r.id, { step: 'workshop', stream: 'stdout', text: `Linked existing #${m.number} "${m.title}" instead of opening "${title}" (${score(similar.score)}).` });
      made.push({ number: m.number, title: m.title, existing: true, instead: title });
      continue;
    }
    const body = `${n.body.trim().slice(0, MAX_RAISED_BODY)}\n\n---\n_Workshop's ${AGENT_INFO[agent].label} agent raised this as a prerequisite of #${t.number}, which waits until this ticket is closed._`;
    const labels = [label.raised, ...(labelsOf(t).includes(label.nominated) ? [label.nominated] : [])];
    const ticket = await source.createTicket(repoRef(ctx.repo), { title, body, labels });
    storeCreated(ctx.repo, ticket, { title, body, labels });
    run('UPDATE tickets SET raised = ? WHERE id = ?', JSON.stringify([...before, { number: ticket.number, url: ticket.url, title, runId: r.id, blocker: true, at: Date.now() }]), t.id);
    checkRaiseRate(ctx.repo);
    made.push({ number: ticket.number, title, existing: false });
  }
  return made.filter((m, i) => m.number !== t.number && made.findIndex((x) => x.number === m.number) === i);
}

const blockersLine = (made: Prerequisite[]) =>
  made.length
    ? `Prerequisite tickets this one waits for:\n${made
        .map((m) => `- #${m.number} ${m.title}${m.instead ? ` (linked existing #${m.number} instead of opening a new ticket for "${m.instead}")` : m.existing ? ' (already open)' : ''}`)
        .join('\n')}`
    : '';

/**
 * Raises a `raise-rate` alert while agents have opened more tickets in the repository in the last hour than the
 * `raiseAlertPerHour` setting allows, and clears it otherwise. It only reports: agents may still open tickets.
 */
export function checkRaiseRate(repo: RepoRow) {
  const since = Date.now() - 3600_000;
  const count = all<{ raised: string }>('SELECT raised FROM tickets WHERE repo_id = ? AND raised IS NOT NULL', repo.id)
    .flatMap((row) => JSON.parse(row.raised) as Raised[])
    .filter((x) => (x.at ?? 0) >= since).length;
  const limit = getSettings().raiseAlertPerHour;
  const ref = `repo:${repo.id}`;
  if (count > limit) {
    raiseAlert(
      'warning',
      'raise-rate',
      `Agents opened ${count} tickets in ${repo.full_name} in the last hour, more than the limit of ${limit}. Check that they aren't duplicates, or turn off "Agents open tickets for what they notice" for this repository.`,
      ref,
    );
  } else clearAlert('raise-rate', ref);
}

const raisedLine = (raised: Raised[]) =>
  raised.length ? `Noticed outside this ticket, and opened as ${raised.length === 1 ? 'its own ticket' : 'their own tickets'}:\n${raised.map((x) => `- #${x.number} ${x.title}`).join('\n')}` : '';

async function publishRun(ctx: Ctx) {
  const r = ctx.run;
  const t = getTicket(r.ticket_id)!;
  ctx.ticket = t;
  const repo = repoRef(ctx.repo);
  const vcs = vcsFor(ctx.repo);
  const branch = branchOf(t);
  const docPath = docPathOf(t);
  const result = JSON.parse(r.result!) as AgentResult;
  const rework = reworkOf(t);
  let saved = r.publish_state ? (JSON.parse(r.publish_state) as PublishState) : null;
  if (!saved) {
    const current = labelsOf(t);
    const planned = planTransition(
      {
        agent: r.agent,
        mode: r.mode,
        labels: current,
        state: parseLabels(current),
        author: t.author,
        docPath,
        docUrl: vcs.fileUrl(repo, branch, docPath),
        rescue: rescueOf(t) ?? undefined,
        rework,
        handoffRunId: handoffOf(t)?.runId,
        mergeWithoutReview: Boolean(ctx.repo.merge_without_review),
        pushToDefault: Boolean(ctx.repo.push_to_default),
        hasPr: t.pr_number !== null,
      },
      result,
    );
    if (planned.failure) throw new Error(planned.failure);
    saved = { plan: planned, labels: current, done: [] };
    setRun(r.id, { publish_state: JSON.stringify(saved) });
  }
  const state = saved;
  const { plan, labels } = state;
  /** Runs one side effect unless an earlier attempt of this publish finished it. */
  const step = async (name: string, fn: () => Promise<unknown>) => {
    if (state.done.includes(name)) return;
    await fn();
    state.done.push(name);
    setRun(r.id, { publish_state: JSON.stringify(state) });
  };

  let pushed: Pushed = state.pushed ?? {};
  if (plan.publish) {
    // A retry after a GitHub failure doesn't push again: the exit code is then the one stored with the report.
    let exitCode = pushed.rescued ? 3 : 0;
    if (!state.pushed) {
      const container = await runContainer(ctx, 'publish', () => publishSpec(ctx), (text) => {
        try {
          pushed = JSON.parse(text);
        } catch {
          // git's own output
        }
      });
      exitCode = container.exitCode;
      if (exitCode === 0 || pushed.rescued) {
        state.pushed = pushed;
        setRun(r.id, { publish_state: JSON.stringify(state) });
      }
    }
    if (exitCode !== 0 && pushed.rescued) {
      const reconciling = parseLabels(labels).stage === 'reconcile';
      const stored = rescueOf(t);
      if (!reconciling) {
        // The work is safe: hand it to the Merge agent instead of failing the run.
        const rescue: Rescue = { branch: pushed.rescued, runId: r.id, agent: r.agent, mode: r.mode, result: result as WorkResult };
        run('UPDATE tickets SET rescue = ? WHERE id = ?', JSON.stringify(rescue), t.id);
        const move = moveTo(labels, 'reconcile');
        await step('labels', () => editLabels(t, move.add, [...move.remove, label.running]));
        await step('comment', () =>
          sourceFor(ctx.repo).comment(
            repo,
            t.number,
            `\`${branch}\` changed on GitHub while the ${AGENT_INFO[r.agent].label} agent was working, and its commits conflict with the new ones. Workshop saved the agent's work on \`${pushed.rescued}\`. The Merge agent will merge it into \`${branch}\` next.`,
          ),
        );
        setRun(r.id, {
          status: 'succeeded',
          step: null,
          container_id: null,
          ended_at: Date.now(),
          error: null,
          publish_retry_at: null,
          summary: `Work saved on ${pushed.rescued}; the Merge agent reconciles it next.`,
        });
        if (r.volume) await ctx.env.removeVolume(r.volume).then(() => setRun(r.id, { volume: null }), () => {});
        return;
      }
      if (stored) run('UPDATE tickets SET rescue = ? WHERE id = ?', JSON.stringify({ ...stored, branch: pushed.rescued }), t.id);
      await sourceFor(ctx.repo).comment(
        repo,
        t.number,
        `\`${branch}\` changed on GitHub again while the Merge agent was working, and its commits conflict with the new ones. Workshop saved the agent's work on \`${pushed.rescued}\` and will try again from the current branch.`,
      );
      throw new Error(`Couldn't push ${branch}: it changed on GitHub and the agent's commits conflict with it. The work is saved on ${pushed.rescued}.`);
    }
    if (exitCode !== 0) throw new Error(`Pushing ${branch} failed (exit ${exitCode}). See the run log.`);
  }
  if (plan.handOff) {
    await step('handoff', async () => {
      // A new pull request needs commits on the branch. (Judging it by "ahead" also covers a restart between
      // pushing and recording the handoff, when nothing is new.)
      if (!t.pr_number && !pushed.ahead) throw new Error('The implementation agent finished without committing any changes.');
      // When reconciling, the pull request describes the interrupted run's work, not the merge.
      const rescued = plan.clearRescue ? rescueOf(t) : null;
      // A rework compares against where its review round started, so one with no new commits still counts as an update.
      const earlier = rework ? handoffOf(t) : null;
      const handoff: Handoff = {
        runId: rescued ? rescued.runId : r.id,
        result: rescued ? rescued.result : (result as WorkResult),
        before: earlier ? earlier.before : pushed.before,
        after: pushed.after,
      };
      run('UPDATE tickets SET handoff = ? WHERE id = ?', JSON.stringify(handoff), t.id);
    });
  }
  let made: Prerequisite[] = [];
  if (plan.addBlockers || plan.raiseBlockers) {
    const by = plan.raisedBy ?? r.agent;
    const name = AGENT_INFO[by].label;
    // Safe to repeat: tickets already raised are reused. Outside the step, because the comment lists them; once
    // linked they're kept with the publish, so a retry lists the same ones even if the setting changed since.
    made = state.prerequisites ?? (plan.raiseBlockers ? await raiseBlockers(ctx, t, plan.raiseBlockers, by) : []);
    const numbers = plan.addBlockers ?? [];
    await step('blockers', async () => {
      if (plan.raiseBlockers && !made.length && !numbers.length) {
        throw new Error(`The ${name} agent asked Workshop to open prerequisite tickets, but this repository doesn't let agents open tickets (or this ticket was itself raised by an agent).`);
      }
      const wanted = [...new Set([...numbers, ...made.map((m) => m.number)])].filter((n) => n !== t.number);
      // Linking a ticket that already waits for this one would leave both waiting for ever.
      const self = refKey(`#${t.number}`, ctx.repo.full_name);
      const waiting = new Set(
        all<TicketRow>("SELECT * FROM tickets WHERE repo_id = ? AND id != ?", t.repo_id, t.id)
          .filter((o) => blockersOf(o).some((b) => refKey(b, ctx.repo.full_name) === self))
          .map((o) => o.number),
      );
      const source = sourceFor(ctx.repo);
      const links = [];
      const cycles = wanted.filter((n) => waiting.has(n));
      for (const n of cycles) warn(r.id, `#${n} already waits for this ticket, so Workshop didn't link it as a blocker.`);
      for (const n of wanted.filter((n) => !waiting.has(n))) links.push(await source.addBlocker(repo, t.number, n));
      const open = links.filter((l) => l.state === 'open');
      const refs = (ns: number[]) => joinRefs(ns.map((n) => `#${n}`));
      // Nothing open would hold nothing, and the agent would run again straight away.
      if (!open.length && !links.length && cycles.length) {
        throw new Error(`The ${name} agent said this ticket waits for ${refs(cycles)}, but ${cycles.length === 1 ? 'that ticket already waits' : 'those tickets already wait'} for this one.`);
      }
      if (!open.length) throw new Error(`The ${name} agent said this ticket waits for ${refs(wanted)}, but none of those is an open issue in ${ctx.repo.full_name}.`);
      setBlockers(t, open.map((l) => linkRef(l, ctx.repo)));
      addLinks(t, links);
      state.prerequisites = made;
    });
  }
  if (plan.createBranch) {
    await step('branch', async () => {
      await vcs.createBranch(repo, branch, { number: t.number, nodeId: t.node_id ?? undefined });
      run('UPDATE tickets SET branch = ? WHERE id = ?', branch, t.id);
    });
  }
  if (plan.ui !== undefined) run('UPDATE tickets SET ui = ? WHERE id = ?', Number(plan.ui), t.id);
  if (plan.deleteMedia) deleteMedia(t.id);
  if (plan.openPr) {
    // Without a handoff (the ticket was moved to code review by hand), the reviewer's summary describes the work.
    await step('pr', () => openOrUpdatePr(ctx, t, handoffOf(t) ?? { runId: r.id, result: result as WorkResult }, plan.reviewNotes, plan.flagged));
    await step('review', () => vcs.requestReview(repo, getTicket(t.id)!.pr_number!, t.author));
  }
  // A rework is stored before the label edit, and cleared only once everything else is done. A retry after a
  // partial failure sends the ticket back again (planReview doesn't count a rework with no new handoff), and
  // an exhausted one opens the pull request rather than sending it back.
  if (plan.rework) run('UPDATE tickets SET rework = ? WHERE id = ?', JSON.stringify(plan.rework), t.id);
  if (plan.deleteBranch) await vcs.deleteBranch(repo, plan.deleteBranch).catch((err) => warn(r.id, `Workshop couldn't delete ${plan.deleteBranch}: ${(err as Error).message}`));
  if (plan.clearRescue) run('UPDATE tickets SET rescue = NULL WHERE id = ?', t.id);
  const raised = await raiseNoticed(ctx, t, result);
  await step('labels', () => editLabels(t, plan.add, [...plan.remove, label.running]));
  const comment = [plan.comment, blockersLine(made), raisedLine(raised)].filter(Boolean).join('\n\n');
  if (comment) await step('comment', () => sourceFor(ctx.repo).comment(repo, t.number, comment));
  // The handoff goes last too, so a retry after a partial failure still has the Implementation summary.
  run(`UPDATE tickets SET failures = 0${plan.rework === null ? ', rework = NULL' : ''}${plan.openPr || plan.noPr ? ', handoff = NULL' : ''} WHERE id = ?`, t.id);
  setRun(r.id, { status: 'succeeded', step: null, container_id: null, ended_at: Date.now(), error: null, publish_retry_at: null });
  if (r.volume) await ctx.env.removeVolume(r.volume).then(() => setRun(r.id, { volume: null }), () => {});
  if (plan.merge) {
    // The scheduler retries merges every tick, so a failure here isn't a failed run.
    await advanceMerge(getTicket(t.id)!).catch((err) => console.warn(`[merge] ${err.message}`));
  }
}

export async function drive(runId: string) {
  if (driving.has(runId)) return;
  driving.add(runId);
  let lost = false;
  try {
    const r = getRun(runId);
    if (!r || !ACTIVE_STATUSES.includes(r.status) || r.status === 'paused') return;
    clearAlert('run-detached', `run:${runId}`);
    const ctx = context(r);
    if (r.status === 'starting') {
      await markRunning(ctx.ticket, true);
      if (!r.image) {
        ctx.image = await chooseImage(ctx);
        setRun(runId, { image: ctx.image });
        ctx.run.image = ctx.image;
        if (getRun(runId)!.status !== 'starting') return; // stopped during a build
      }
      if (!r.container_id) {
        await ctx.env.createVolume(r.volume!, ctx.labels);
      }
      const state = await runContainer(ctx, 'prepare', () => prepareSpec(ctx));
      if (getRun(runId)!.status !== 'starting') return; // stopped meanwhile
      if (state.exitCode !== 0) throw new Error(`Preparing the repository failed (exit ${state.exitCode}). See the run log.`);
      setRun(runId, { status: 'running', step: null, container_id: null });
      Object.assign(ctx.run, { status: 'running', step: null, container_id: null });
    }
    if (ctx.run.status === 'running' && !(await runAgent(ctx))) return;
    const latest = getRun(runId)!;
    if (latest.status === 'publishing') {
      ctx.run = latest;
      try {
        await publishRun(ctx);
      } catch (err) {
        if (err instanceof HostUnreachable || !isTransient(err)) throw err;
        await deferPublish(getRun(runId)!, err);
      }
    }
  } catch (err) {
    if (err instanceof HostUnreachable) {
      // The run still holds its slot, and kicking here would only re-attach to the unreachable host again.
      lost = true;
      raiseAlert('warning', 'run-detached', `${err.message} The agent may still be working; Workshop reconnects when the host is back.`, `run:${runId}`);
      return;
    }
    console.error(`[run ${runId}]`, err);
    await fail(runId, errorText(err));
  } finally {
    driving.delete(runId);
    if (!lost) settled();
  }
}

function errorText(err: unknown): string {
  // Octokit uses the response body as the message, so a 5xx with an empty body has none.
  const { message, status } = err as Error & { status?: number };
  return message || (status ? `GitHub answered HTTP ${status} with no message.` : String(err));
}

/**
 * GitHub failed temporarily while publishing: keeps the run publishing and lets the tick try again later,
 * without counting a failure or running the agent again. After `PUBLISH_GIVE_UP_MS` it fails the run.
 */
async function deferPublish(r: RunRow, err: unknown) {
  const now = Date.now();
  const since = r.publish_failing_since ?? now;
  const detail = errorText(err);
  if (now - since >= PUBLISH_GIVE_UP_MS) {
    const t = getTicket(r.ticket_id)!;
    const repo = getRepo(t.repo_id)!;
    raiseAlert(
      'error',
      'publish-failed',
      `${repo.full_name}#${t.number}: Workshop couldn't publish the ${AGENT_INFO[r.agent].label} agent's work because GitHub kept failing for 6 hours. Last error: ${detail}`,
      `run:${r.id}`,
    );
    await fail(r.id, `GitHub kept failing for 6 hours, so Workshop stopped trying to publish. Last error: ${detail}`);
    return;
  }
  const minutes = publishRetryMinutes(r.publish_retries);
  // At a rate limit, try again just after GitHub says it resets, not on the usual schedule.
  const resets = isRateLimited(err) ? vcsFor(getRepo(getTicket(r.ticket_id)!.repo_id)!).rateLimitedUntil?.() : null;
  const at = resets ? resets + 30_000 : now + minutes * 60_000;
  const when = resets ? `after GitHub's rate limit resets at ${formatTime(at, getSettings().timezone, now)}` : `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const text = `GitHub didn't answer (${detail}). Workshop tries publishing again ${when}.`;
  setRun(r.id, { error: text, step: null, container_id: null, publish_retries: r.publish_retries + 1, publish_retry_at: at, publish_failing_since: since });
  appendLog(r.id, { step: 'workshop', stream: 'stdout', text });
}

export function launch(p: {
  ticketId: number;
  agent: AgentName;
  mode: 'normal' | 'delta';
  attempt: number;
  environmentId: number;
  /** The container size, which picks the host's limits and the slot the run holds. Standard when left out. */
  size?: AgentSize;
  modelConnectionId: number;
  model: string;
  billing: Billing;
}): string | null {
  const id = crypto.randomUUID();
  try {
    run(
      `INSERT INTO runs (id, ticket_id, agent, mode, attempt, environment_id, size, model_connection_id, model, billing, status, volume, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
      id,
      p.ticketId,
      p.agent,
      p.mode,
      p.attempt,
      p.environmentId,
      p.size ?? 'standard',
      p.modelConnectionId,
      p.model,
      p.billing,
      `workshop-run-${id}`,
      Date.now(),
    );
  } catch (err) {
    if (String(err).includes('UNIQUE')) return null; // another agent already has this ticket
    throw err;
  }
  publish('runs');
  publish('tickets');
  void drive(id);
  return id;
}

/**
 * Continues a paused run (usage limit, its subscription's limits, by hand or a paused subscription) in the same Claude session
 * on the same host, with the credentials of the connection it's on now (another subscription, after a move).
 */
export function resume(runId: string) {
  const r = getRun(runId);
  if (r?.status !== 'paused') return;
  setRun(runId, { status: 'running', step: 'run', container_id: null, resets_at: null, pause_reason: null, pause_requested_at: null, resumes: r.resumes + 1 });
  void drive(runId);
}

/**
 * Asks a run to pause by hand. A starting or running agent stops at its next turn boundary; a run
 * already paused for usage stays paused after the limit resets. Either way it waits for you to resume it.
 */
export function requestPause(runId: string) {
  const r = getRun(runId);
  check(r, 'Run not found.', 404);
  check(r.status !== 'publishing', "The agent has finished and is publishing its work, so it can't be paused.", 409);
  check(ACTIVE_STATUSES.includes(r.status), 'This run has already ended.', 409);
  if (r.status === 'paused') {
    if (r.pause_reason === 'manual') return;
    setRun(runId, { pause_reason: 'manual' });
    appendLog(runId, { step: 'workshop', stream: 'stdout', text: 'Kept paused from Workshop. It waits for you to resume it, even after the usage limit resets.' });
    return;
  }
  if (r.pause_requested_at) return;
  setRun(runId, { pause_requested_at: Date.now() });
  appendLog(runId, { step: 'workshop', stream: 'stdout', text: 'Pause requested from Workshop. The agent stops after its current step.' });
  pauseSignals.get(runId)?.();
}

/**
 * A subscription was just paused: its running agents stop at their next turn boundary (at once if they're
 * between turns), and the tick moves them to another subscription.
 */
export function connectionPaused(connectionId: number) {
  const name = getConnection(connectionId)?.name ?? 'The Claude connection';
  for (const r of all<RunRow>("SELECT * FROM runs WHERE status IN ('starting', 'running') AND billing = 'subscription' AND model_connection_id = ?", connectionId)) {
    appendLog(r.id, { step: 'workshop', stream: 'stdout', text: `${name} was paused. The agent moves to another Claude subscription after its current step.` });
    pauseSignals.get(r.id)?.();
  }
}

/** Moves a paused run to another Claude subscription. It resumes there in the same session when that one allows. */
export function switchConnection(runId: string, toId: number) {
  const r = getRun(runId);
  if (r?.status !== 'paused' || r.model_connection_id === toId) return;
  const from = getConnection(r.model_connection_id)?.name ?? 'its subscription';
  const to = getConnection(toId)?.name ?? 'another subscription';
  // A usage limit or threshold on the old subscription says nothing about the new one; a pause you asked for stays yours.
  const reason = r.pause_reason === 'manual' ? {} : { pause_reason: 'connection', resets_at: null };
  setRun(runId, { model_connection_id: toId, switched_from: r.model_connection_id, ...reason });
  appendLog(runId, { step: 'workshop', stream: 'stdout', text: `Moved from ${from} to ${to} because ${from} is paused.` });
}

/** Cancels a run without counting a failure or changing labels, so the queue starts the same stage again. */
export async function abortRun(runId: string, reason: string) {
  appendLog(runId, { step: 'workshop', stream: 'stdout', text: reason });
  await stopRun(runId, reason, false);
}

/** Takes back a pause you asked for that hasn't happened yet. Returns false if there was none. */
export function cancelPause(runId: string): boolean {
  const r = getRun(runId);
  if (!r || (r.status !== 'starting' && r.status !== 'running') || !r.pause_requested_at) return false;
  setRun(runId, { pause_requested_at: null });
  appendLog(runId, { step: 'workshop', stream: 'stdout', text: 'Pause cancelled from Workshop. The agent keeps working.' });
  return true;
}

export async function fail(runId: string, message: string) {
  const r = getRun(runId);
  if (!r || !ACTIVE_STATUSES.includes(r.status)) return;
  setRun(runId, { status: 'failed', error: message, step: null, container_id: null, ended_at: Date.now() });
  activity.delete(runId);
  const t = getTicket(r.ticket_id);
  if (!t) return;
  const failures = t.failures + 1;
  run('UPDATE tickets SET failures = ? WHERE id = ?', failures, t.id);
  await markRunning(t, false);
  if (failures < MAX_ATTEMPTS) return;
  const repo = getRepo(t.repo_id)!;
  const name = AGENT_INFO[r.agent].label;
  raiseAlert('error', 'ticket-failed', `${repo.full_name}#${t.number}: ${name} failed ${failures} times. Last error: ${message}`, `ticket:${t.id}`);
  try {
    await editLabels(t, [label.failed], []);
    await sourceFor(repo).comment(
      repoRef(repo),
      t.number,
      `Workshop stopped after ${failures} failed attempts at **${name}**:\n\n> ${message}\n\nRemove the \`${label.failed}\` label to try again.`,
    );
  } catch (err) {
    console.warn(`Couldn't mark #${t.number} as failed on the ticket: ${(err as Error).message}`);
  }
}

/** Stops a run. With `hold`, labels the ticket failed so Workshop doesn't immediately start it again. */
export async function stopRun(runId: string, reason: string, hold: boolean) {
  const r = getRun(runId);
  if (!r || !ACTIVE_STATUSES.includes(r.status)) return;
  setRun(runId, { status: 'cancelled', error: reason, ended_at: Date.now() });
  activity.delete(runId);
  const conn = getConnection(r.environment_id);
  if (conn && r.container_id) await environmentOf(conn).kill(r.container_id).catch(() => {});
  // A paused run or one waiting to publish isn't being driven, so nothing else tells the scheduler.
  settled();
  const t = getTicket(r.ticket_id);
  if (!t) return;
  await markRunning(t, false);
  if (!hold) return;
  const repo = getRepo(t.repo_id)!;
  try {
    await editLabels(t, [label.failed], []);
    await sourceFor(repo).comment(repoRef(repo), t.number, `Stopped from Workshop. Remove the \`${label.failed}\` label to let Workshop try this stage again.`);
  } catch (err) {
    console.warn(`Couldn't label #${t.number} after stopping: ${(err as Error).message}`);
  }
}
