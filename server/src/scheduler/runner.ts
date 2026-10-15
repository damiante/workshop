import crypto from 'node:crypto';
import type { AgentName, Billing } from '../api-types.ts';
import { getAgent, promptFor, type AgentRow } from '../agents.ts';
import { clearAlert, raiseAlert } from '../alerts.ts';
import { recordLimit, recordProbe } from '../allowance.ts';
import { config } from '../config.ts';
import { all, run } from '../db.ts';
import { publish } from '../events.ts';
import { hitUsageLimit, readClaudeLine, type ClaudeRun } from '../providers/anthropic/index.ts';
import type { DockerConfig } from '../providers/docker/index.ts';
import { environmentOf, getConnection, modelsOf } from '../providers/index.ts';
import type { ContainerState, Environment, StepSpec } from '../providers/types.ts';
import { ACTIVE_STATUSES, activity, appendLog, getRun, linesFrom, readLog, type RunRow } from '../runs.ts';
import { getSettings } from '../settings.ts';
import {
  branchOf,
  docPathOf,
  editLabels,
  getRepo,
  getTicket,
  isAllowedAuthor,
  labelsOf,
  linkRef,
  markRunning,
  MAX_ATTEMPTS,
  repoRef,
  setBlockers,
  sourceFor,
  vcsFor,
  type RepoRow,
  type TicketRow,
} from '../tickets.ts';
import { label, parseLabels } from '../workflow/labels.ts';
import { AGENT_INFO, protocolText, taskPrompt } from '../workflow/prompts.ts';
import { parseResult, schemaFor, type AgentResult, type WorkResult } from '../workflow/schemas.ts';
import { planTransition } from '../workflow/transitions.ts';
import { joinRefs } from './gates.ts';
import { advanceMerge } from './merge.ts';

// A run moves starting (prepare) → running (claude) → publishing (push + ticket updates) → succeeded.
// Each step is a container on the run's volume. Status, step and container id are persisted, so after
// a restart or a lost host Workshop re-attaches to the container and carries on from the same step.

type StepName = 'prepare' | 'run' | 'publish';

class HostUnreachable extends Error {}

const USAGE_RECORD_MS = 30_000;
const driving = new Set<string>();
export const isDriving = (id: string) => driving.has(id);

let settled = () => {};
/** Called whenever a run stops being driven (the scheduler uses it to look for the next job). */
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
    image: repo.image || config.agentImage,
    labels: { 'workshop.instance': config.instance, 'workshop.run': r.id, 'workshop.ticket': `${repo.full_name}#${ticket.number}`, 'workshop.agent': r.agent },
  };
}

/** Starts (or re-attaches to) the container for one step, streams its log, and waits for it to exit. */
async function runContainer(
  ctx: Ctx,
  step: StepName,
  makeSpec: () => Promise<Pick<StepSpec, 'cmd' | 'env' | 'files'>>,
  onStdout?: (text: string) => void,
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
    const memoryGb = ctx.host.cfg.memoryGb;
    id = await ctx.env.start({
      ...spec,
      image: ctx.image,
      volume: ctx.run.volume ?? undefined,
      labels: { ...ctx.labels, 'workshop.step': step },
      cpus: ctx.host.cfg.cpus,
      memoryMb: memoryGb ? memoryGb * 1024 : undefined,
    });
    setRun(ctx.run.id, { step, container_id: id });
    Object.assign(ctx.run, { step, container_id: id });
  }
  const containerId = id;
  const short = id.slice(0, 12);
  if (reattached && onStdout) for (const e of readLog(ctx.run.id)) if (e.container === short && e.stream === 'stdout') onStdout(e.text);
  let timedOut = false;
  const timer = timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        void ctx.env.kill(containerId);
      }, timeoutMs)
    : undefined;
  try {
    await ctx.env.follow(containerId, reattached ? linesFrom(ctx.run.id, short) : 0, (line) => {
      appendLog(ctx.run.id, { step, stream: line.stream, text: line.text, container: short });
      if (line.stream === 'stdout') onStdout?.(line.text);
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
    MAX_TURNS: String(agent.max_turns),
    MAX_BUDGET_USD: r.billing === 'api' ? String(getSettings().apiRunCapUsd) : '',
    RESUME: r.resumes > 0 ? '1' : '',
  };
  const files: Record<string, string> = { '.workshop/': '', '.workshop/schema.json': JSON.stringify(schemaFor(r.agent)) };
  if (r.resumes === 0) {
    const t = ctx.ticket;
    const repo = repoRef(ctx.repo);
    const source = sourceFor(ctx.repo);
    const labels = labelsOf(t);
    const comments = await source.comments(repo, t.number);
    const included = comments.filter((c) => isAllowedAuthor(c.author) || c.author === source.selfLogin());
    const review = t.pr_number && r.agent !== 'merge' ? await vcsFor(ctx.repo).reviewFeedback(repo, t.pr_number, getSettings().authors) : [];
    const branch = branchOf(t);
    const docPath = docPathOf(t);
    const openTickets =
      r.agent === 'classifier'
        ? all<{ number: number; title: string; body: string; author: string }>(
            "SELECT number, title, body, author FROM tickets WHERE repo_id = ? AND state = 'open' AND id != ? ORDER BY updated_at DESC",
            ctx.repo.id,
            t.id,
          ).filter((o) => isAllowedAuthor(o.author))
        : undefined;
    files['.workshop/system.md'] = `${promptFor(agent)}\n\n${protocolText({ branch, base: ctx.repo.default_branch })}`;
    files['.workshop/prompt.md'] = taskPrompt({
      agent: r.agent,
      mode: r.mode,
      repo: ctx.repo.full_name,
      base: ctx.repo.default_branch,
      branch,
      docPath,
      ticket: { number: t.number, title: t.title, body: t.body, url: t.url, labels, size: parseLabels(labels).size },
      comments: included,
      omittedComments: comments.length - included.length,
      review,
      openTickets,
    });
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

function describeError(res: NonNullable<ClaudeRun['result']>, agent: AgentRow): string {
  switch (res.subtype) {
    case 'error_max_turns':
      return `Reached the ${agent.max_turns}-turn limit.`;
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
          ? `Waiting for ${joinRefs((r.blocked_by ?? []).map((n) => `#${n}`))}`
          : 'Asked questions';
  return `${what}: ${r.reason}`;
};

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
  let trailing: NodeJS.Timeout | undefined;
  const running = runContainer(
    ctx,
    'run',
    () => runSpec(ctx, agent),
    (text) => {
      const before = claude.activity;
      const hadResult = !!claude.result;
      readClaudeLine(claude, text);
      // Every run reports current subscription usage: a free, fresh reading for the allowance gate and
      // the usage bars. Recorded whenever it changes, at most every 30 seconds.
      if (Date.now() - recordedAt >= USAGE_RECORD_MS) recordUsage();
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
    agent.timeout_min * 60_000,
  );
  // Record what the run reported even if the container failed.
  const state = await running.finally(recordUsage);
  clearTimeout(trailing);
  activity.delete(r.id);
  publish('runs');
  if (getRun(r.id)!.status !== 'running') return false; // stopped while it ran
  const res = claude.result;
  setRun(r.id, { exit_code: state.exitCode, input_tokens: res?.inputTokens ?? null, output_tokens: res?.outputTokens ?? null, cost_usd: res?.costUsd ?? null });

  if (claude.limit && r.model_connection_id) recordLimit(r.model_connection_id, claude.limit.resetsAt ?? Date.now() + 3600_000);
  if (state.oomKilled) {
    raiseAlert('warning', 'container-killed', `${ctx.labels['workshop.ticket']}: the ${name} agent ran out of memory on ${ctx.host.name}.`, `run:${r.id}`);
    throw new Error(`Ran out of memory (limit ${ctx.host.cfg.memoryGb ?? '?'} GB per agent on ${ctx.host.name}).`);
  }
  if (hitUsageLimit(claude)) {
    setRun(r.id, { status: 'paused', step: 'run', container_id: null, resets_at: claude.limit?.resetsAt ?? Date.now() + 3600_000 });
    await markRunning(ctx.ticket, false);
    return false;
  }
  if (claude.apiError === 'authentication_failed') {
    raiseAlert('error', 'claude-auth', 'Claude rejected the credentials Workshop used. For a subscription, run "claude setup-token" again and update the Claude connection.', `model:${r.model_connection_id}`);
  }
  if (!res) {
    if (state.timedOut) throw new Error(`Stopped after the ${agent.timeout_min}-minute time limit.`);
    if (state.exitCode === 137 || state.exitCode === 143) {
      raiseAlert('warning', 'container-killed', `${ctx.labels['workshop.ticket']}: the ${name} container was killed on ${ctx.host.name} (exit ${state.exitCode}).`, `run:${r.id}`);
    }
    throw new Error(`Claude Code exited (code ${state.exitCode}) without a result. See the run log.`);
  }
  if (res.isError) throw new Error(describeError(res, agent));
  const parsed = parseResult(r.agent, res.structured);
  if (typeof parsed === 'string') throw new Error(`The agent's result was invalid: ${parsed}`);
  setRun(r.id, { status: 'publishing', step: null, container_id: null, result: JSON.stringify(parsed), summary: summarize(parsed) });
  return true;
}

/** What the publish step reports: the branch before and after the push, and commits ahead of base. */
interface Pushed {
  before?: string;
  after?: string;
  ahead?: number;
}

async function openOrUpdatePr(ctx: Ctx, t: TicketRow, result: WorkResult, pushed: Pushed) {
  const repo = repoRef(ctx.repo);
  const vcs = vcsFor(ctx.repo);
  const branch = branchOf(t);
  const tests = result.tests ? `\n\n**Tests:** ${result.tests}` : '';
  let number = t.pr_number ?? (await vcs.findPullRequest(repo, branch));
  // A new pull request needs commits on the branch; an update after review needs new ones. (Judging a
  // new PR by "ahead" also covers a restart between pushing and opening the PR, when nothing is new.)
  if (number ? pushed.before === pushed.after : !pushed.ahead) throw new Error('The implementation agent finished without committing any changes.');
  let url = t.pr_url;
  if (number) {
    await vcs.commentOnPullRequest(repo, number, `Updated after review.\n\n${result.summary}${tests}`);
  } else {
    const size = parseLabels(labelsOf(t)).size;
    const design = size === 'm' || size === 'l' || size === 'xl' ? `\n\n**Design:** [\`${docPathOf(t)}\`](${vcs.fileUrl(repo, branch, docPathOf(t))})` : '';
    const body = `${result.summary}${tests}${design}\n\nCloses #${t.number}\n\n---\n_Opened by Workshop. Approve to merge it, or request changes and Workshop will work on them._`;
    const pr = await vcs.openPullRequest(repo, { branch, title: t.title, body });
    number = pr.number;
    url = pr.url;
  }
  run("UPDATE tickets SET pr_number = ?, pr_url = ?, pr_status = 'review' WHERE id = ?", number, url, t.id);
  await vcs.requestReview(repo, number, t.author);
}

async function publishRun(ctx: Ctx) {
  const r = ctx.run;
  const t = getTicket(r.ticket_id)!;
  ctx.ticket = t;
  const repo = repoRef(ctx.repo);
  const vcs = vcsFor(ctx.repo);
  const labels = labelsOf(t);
  const branch = branchOf(t);
  const docPath = docPathOf(t);
  const result = JSON.parse(r.result!) as AgentResult;
  const plan = planTransition(
    { agent: r.agent, mode: r.mode, labels, state: parseLabels(labels), author: t.author, docPath, docUrl: vcs.fileUrl(repo, branch, docPath) },
    result,
  );
  if (plan.failure) throw new Error(plan.failure);

  let pushed: Pushed = {};
  if (plan.publish) {
    const state = await runContainer(ctx, 'publish', () => publishSpec(ctx), (text) => {
      try {
        pushed = JSON.parse(text);
      } catch {
        // git's own output
      }
    });
    if (state.exitCode !== 0) throw new Error(`Pushing ${branch} failed (exit ${state.exitCode}). See the run log.`);
  }
  if (plan.addBlockers) {
    const source = sourceFor(ctx.repo);
    const open = [];
    for (const n of plan.addBlockers.filter((n) => n !== t.number)) {
      const link = await source.addBlocker(repo, t.number, n);
      if (link.state === 'open') open.push(link);
    }
    // Nothing open would hold nothing, and the Classifier would run again straight away.
    if (!open.length) {
      throw new Error(`The Classifier said this ticket waits for ${joinRefs(plan.addBlockers.map((n) => `#${n}`))}, but none of those is an open issue in ${ctx.repo.full_name}.`);
    }
    setBlockers(t, open.map((l) => linkRef(l, ctx.repo)));
  }
  if (plan.createBranch) {
    await vcs.createBranch(repo, branch, { number: t.number, nodeId: t.node_id ?? undefined });
    run('UPDATE tickets SET branch = ? WHERE id = ?', branch, t.id);
  }
  if (plan.openPr) await openOrUpdatePr(ctx, t, result as WorkResult, pushed);
  await editLabels(t, plan.add, [...plan.remove, label.running]);
  if (plan.comment) await sourceFor(ctx.repo).comment(repo, t.number, plan.comment);
  run('UPDATE tickets SET failures = 0 WHERE id = ?', t.id);
  setRun(r.id, { status: 'succeeded', step: null, container_id: null, ended_at: Date.now() });
  if (r.volume) await ctx.env.removeVolume(r.volume).then(() => setRun(r.id, { volume: null }), () => {});
  if (plan.merge) {
    // The scheduler retries merges every tick, so a failure here isn't a failed run.
    await advanceMerge(getTicket(t.id)!).catch((err) => console.warn(`[merge] ${err.message}`));
  }
}

export async function drive(runId: string) {
  if (driving.has(runId)) return;
  driving.add(runId);
  try {
    const r = getRun(runId);
    if (!r || !ACTIVE_STATUSES.includes(r.status) || r.status === 'paused') return;
    clearAlert('run-detached', `run:${runId}`);
    const ctx = context(r);
    if (r.status === 'starting') {
      await markRunning(ctx.ticket, true);
      if (!r.container_id) {
        await ctx.env.ensureImage(ctx.image);
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
      await publishRun(ctx);
    }
  } catch (err) {
    if (err instanceof HostUnreachable) {
      raiseAlert('warning', 'run-detached', `${err.message} The agent may still be working; Workshop reconnects when the host is back.`, `run:${runId}`);
      return;
    }
    console.error(`[run ${runId}]`, err);
    await fail(runId, (err as Error).message);
  } finally {
    driving.delete(runId);
    settled();
  }
}

export function launch(p: {
  ticketId: number;
  agent: AgentName;
  mode: 'normal' | 'delta';
  attempt: number;
  environmentId: number;
  modelConnectionId: number;
  model: string;
  billing: Billing;
}): string | null {
  const id = crypto.randomUUID();
  try {
    run(
      `INSERT INTO runs (id, ticket_id, agent, mode, attempt, environment_id, model_connection_id, model, billing, status, volume, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
      id,
      p.ticketId,
      p.agent,
      p.mode,
      p.attempt,
      p.environmentId,
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

/** Continues a run paused by a usage limit, in the same Claude session on the same host. */
export function resume(runId: string) {
  const r = getRun(runId);
  if (r?.status !== 'paused') return;
  setRun(runId, { status: 'running', step: 'run', container_id: null, resets_at: null, resumes: r.resumes + 1 });
  void drive(runId);
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
