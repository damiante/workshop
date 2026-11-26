import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { agentViews, updateAgent } from '../agents.ts';
import { allowanceOf, allowanceViews, apiSpendSince } from '../allowance.ts';
import type { AgentClassView, AgentName, AlertView, LogEntry, ModelOption, TaskRepo, TasksView, TicketLifecycle, TicketMedia, Overview, Settings, TicketStatePatch, Usage } from '../api-types.ts';
import { all, one, run } from '../db.ts';
import { bus, openSse, publish } from '../events.ts';
import { listMedia, mediaDir, mediaView } from '../media.ts';
import { getConnection, listConnections, modelsOf, setLimits } from '../providers/index.ts';
import { ACTIVE_STATUSES, getRun, logBus, readLog, runView, runViews, ticketRunViews } from '../runs.ts';
import { pushRefusal, withinHours } from '../scheduler/gates.ts';
import { hostViews, kick, launchNow, MAX_TASK_PROMPT, newTask, queueView, refreshNow, resumeNow, startOfDay, startTaskRun, syncSoon, TASK_AGENT_ERROR } from '../scheduler/loop.ts';
import { requestPause, stopRun } from '../scheduler/runner.ts';
import { getSettings, saveSettings, TICKET_ORDERS } from '../settings.ts';
import { lifetimeSpend } from '../spend.ts';
import { getTask, setTaskClosed, taskTitle, taskView, taskViews } from '../tasks.ts';
import { activeRunId, editLabels, getRepo, getTicket, isAllowedAuthor, labelsOf, listTicketViews, setDismissed, setPrioritised, setPush, ticketInScope, ticketView } from '../tickets.ts';
import { label, SIZES, STAGES, stateEdits } from '../workflow/labels.ts';
import { CONTENT_TYPES, extType, validName } from '../workflow/media.ts';
import { AGENT_NAMES, TASK_AGENTS } from '../workflow/prompts.ts';
import { OPENAPI } from './openapi.ts';
import { check, HttpError, int, num } from './util.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function alertViews(where: string, limit: number): AlertView[] {
  return all<{ id: number; level: AlertView['level']; kind: string; message: string; ref: string | null; created_at: number; ack_at: number | null }>(
    `SELECT * FROM alerts WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    limit,
  ).map((a) => ({ id: a.id, level: a.level, kind: a.kind, message: a.message, ref: a.ref, runId: alertRunId(a.ref), createdAt: a.created_at, ackAt: a.ack_at }));
}

/** The run an alert is about: a `run:` ref names it directly; a `ticket:` ref points at that ticket's latest run. */
function alertRunId(ref: string | null): string | null {
  const [type, id] = (ref ?? '').split(':');
  if (type === 'run') return one<{ id: string }>('SELECT id FROM runs WHERE id = ?', id)?.id ?? null;
  if (type === 'ticket') return one<{ id: string }>('SELECT id FROM runs WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1', Number(id))?.id ?? null;
  return null;
}

function validTimeZone(tz: unknown) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(tz) });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

export const apiRouter = Router();

apiRouter.get('/overview', (_req, res) => {
  const s = getSettings();
  const tickets = listTicketViews();
  const waiting = tickets.filter((t) => t.attention);
  const overview: Overview = {
    mode: s.mode,
    withinHours: withinHours(s, new Date()),
    allowance: allowanceViews(),
    running: runViews("runs.status IN ('starting', 'running', 'publishing', 'paused')"),
    needsYou: waiting.filter((t) => !t.dismissed),
    dismissed: waiting.filter((t) => t.dismissed),
    queue: queueView(),
    hosts: hostViews(),
    alerts: alertViews('ack_at IS NULL', 20),
  };
  res.json(overview);
});

apiRouter.get('/usage/lifetime', (_req, res) => {
  res.json(lifetimeSpend(getSettings().timezone));
});

apiRouter.get('/usage', (_req, res) => {
  const s = getSettings();
  const usage: Usage = {
    allowance: allowanceViews(),
    apiSpendTodayUsd: apiSpendSince(startOfDay(Date.now(), s.timezone)),
    apiRunCapUsd: s.apiRunCapUsd,
    apiDailyCapUsd: s.apiDailyCapUsd,
  };
  res.json(usage);
});

/** A Claude subscription's own usage limits. */
apiRouter.put('/usage/limits/:connectionId', (req, res) => {
  const c = getConnection(Number(req.params.connectionId));
  check(c && c.kind === 'model' && c.secret.oauthToken, "That isn't a Claude subscription connection.", 404);
  const b = req.body ?? {};
  const limits = { ...c.limits };
  if (b.fiveHour !== undefined) limits.fiveHour = num(b.fiveHour, '5-hour limit', 0, 100);
  if (b.weekly !== undefined) limits.weekly = num(b.weekly, 'Weekly limit', 0, 100);
  setLimits(c.id, limits);
  // Launches and threshold-paused runs are reconsidered at once.
  kick();
  res.json(allowanceOf(c.id, c.name, limits));
});

apiRouter.get('/openapi.json', (_req, res) => {
  res.json(OPENAPI);
});

apiRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
});

apiRouter.put('/settings', (req, res) => {
  const b = req.body ?? {};
  const patch: Partial<Settings> = {};
  if (b.mode !== undefined) {
    check(['paused', 'scheduled', 'always'].includes(b.mode), 'Unknown operation mode.');
    patch.mode = b.mode;
  }
  if (b.timezone !== undefined) {
    check(validTimeZone(b.timezone), `"${b.timezone}" isn't a time zone. Use a name like Australia/Melbourne.`);
    patch.timezone = b.timezone;
  }
  if (b.days !== undefined) {
    check(Array.isArray(b.days) && b.days.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6), 'Days must be numbers from 0 (Sunday) to 6.');
    patch.days = [...new Set<number>(b.days)].sort();
  }
  for (const key of ['start', 'end'] as const) {
    if (b[key] === undefined) continue;
    check(/^([01]\d|2[0-3]):[0-5]\d$/.test(b[key]), 'Times must be HH:MM, e.g. 22:00.');
    patch[key] = b[key];
  }
  check(b.fiveHourMax === undefined && b.weeklyMax === undefined, 'Usage limits are set per subscription now: PUT /api/usage/limits/:connectionId.');
  if (b.apiRunCapUsd !== undefined) patch.apiRunCapUsd = num(b.apiRunCapUsd, 'API cap per run', 0, 1000);
  if (b.apiDailyCapUsd !== undefined) patch.apiDailyCapUsd = num(b.apiDailyCapUsd, 'API cap per day', 0, 10000);
  if (b.pollMinutes !== undefined) patch.pollMinutes = int(b.pollMinutes, 'Polling interval', 1, 60);
  if (b.ticketOrder !== undefined) {
    check(TICKET_ORDERS.includes(b.ticketOrder), 'Unknown ticket order.');
    patch.ticketOrder = b.ticketOrder;
  }
  if (b.retentionDays !== undefined) patch.retentionDays = int(b.retentionDays, 'Retention', 1, 365);
  if (b.authors !== undefined) {
    check(Array.isArray(b.authors) && b.authors.every((a: unknown) => typeof a === 'string'), 'Authors must be a list of GitHub usernames.');
    const authors = [...new Set<string>(b.authors.map((a: string) => a.trim().replace(/^@/, '')).filter(Boolean))];
    check(authors.every((a) => /^[A-Za-z0-9-]{1,39}$/.test(a)), 'GitHub usernames contain only letters, numbers and hyphens.');
    patch.authors = authors;
  }
  const before = getSettings();
  const next = saveSettings(patch);
  // Newly allowed authors may have open tickets that earlier syncs skipped.
  if (patch.authors && patch.authors.join() !== before.authors.join()) run('UPDATE repos SET synced_at = NULL');
  publish('settings');
  syncSoon();
  res.json(next);
});

apiRouter.get('/agents', (_req, res) => {
  res.json(agentViews());
});

apiRouter.put('/agents/:name', (req, res) => {
  const name = req.params.name as AgentName;
  check(AGENT_NAMES.includes(name), 'Unknown agent.', 404);
  const b = req.body ?? {};
  const patch: Partial<AgentClassView> = {};
  if ('model' in b) {
    check(b.model === null || (typeof b.model === 'string' && /^[\w.\-:]+$/.test(b.model)), 'Choose a model.');
    patch.model = b.model;
  }
  if ('modelConnectionId' in b) {
    check(b.modelConnectionId === null || getConnection(Number(b.modelConnectionId))?.kind === 'model', 'Choose a Claude connection.');
    patch.modelConnectionId = b.modelConnectionId === null ? null : Number(b.modelConnectionId);
  }
  if ('effort' in b) {
    check(b.effort === null || EFFORTS.includes(b.effort), `Effort must be one of ${EFFORTS.join(', ')}.`);
    patch.effort = b.effort;
  }
  if ('billing' in b) {
    check(b.billing === 'subscription' || b.billing === 'api', 'Billing must be subscription or api.');
    patch.billing = b.billing;
  }
  if ('prompt' in b) {
    check(typeof b.prompt === 'string' && b.prompt.length <= 20_000, 'The prompt must be text under 20,000 characters.');
    patch.prompt = b.prompt;
  }
  if ('maxTurns' in b) patch.maxTurns = int(b.maxTurns, 'Max turns', 1, 2000);
  if ('timeoutMin' in b) patch.timeoutMin = int(b.timeoutMin, 'Time limit', 5, 1440);
  updateAgent(name, patch);
  kick();
  res.json(agentViews().find((a) => a.name === name));
});

apiRouter.get('/models', (_req, res) => {
  const options: ModelOption[] = listConnections('model').flatMap((c) => {
    const provider = modelsOf(c);
    return provider.models().map((m) => ({ connectionId: c.id, connectionName: c.name, id: m.id, label: m.label, billing: provider.billing() }));
  });
  res.json(options);
});

apiRouter.get('/tickets', (req, res) => {
  res.json(listTicketViews(req.query.closed === '1'));
});

apiRouter.put('/hosts/:id', (req, res) => {
  const id = int(req.params.id, 'Host id', 1, Number.MAX_SAFE_INTEGER);
  const conn = getConnection(id);
  check(conn?.kind === 'environment', 'Agent host not found.', 404);
  const { available } = req.body ?? {};
  check(typeof available === 'boolean', 'available must be true or false.');
  // json_set leaves updated_at alone, so the cached client (and its pinned SSH host key) stays.
  run("UPDATE connections SET config = json_set(config, '$.available', json(?)) WHERE id = ?", JSON.stringify(available), id);
  publish('connections');
  kick();
  res.json(hostViews().find((h) => h.id === id));
});

apiRouter.post('/tickets/:id/launch', (req, res) => {
  const id = launchNow(int(req.params.id, 'Ticket id', 1, Number.MAX_SAFE_INTEGER));
  res.status(202).json(runView(id));
});

apiRouter.get('/tasks', (_req, res) => {
  const repos = all<{ id: number; full_name: string }>('SELECT id, full_name FROM repos ORDER BY enabled DESC, full_name').map((r): TaskRepo => ({ id: r.id, fullName: r.full_name }));
  const body: TasksView = { repos, agents: TASK_AGENTS, tasks: taskViews() };
  res.json(body);
});

const MAX_TASK_TITLE = 200;

function taskAgent(value: unknown, fallback: AgentName | null): AgentName {
  if (value === undefined && fallback) return fallback;
  check(TASK_AGENTS.includes(value as AgentName), TASK_AGENT_ERROR);
  return value as AgentName;
}

const browserFlag = (value: unknown) => {
  check(value === undefined || typeof value === 'boolean', 'browser must be true or false.');
  return value === true;
};

/** Creates a task, a virtual ticket outside the workflow, and starts its first agent now or not at all. */
apiRouter.post('/tasks', async (req, res) => {
  const b = req.body ?? {};
  const repoId = int(b.repoId, 'Repository id', 1, Number.MAX_SAFE_INTEGER);
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  check(body.length >= 1, 'Describe the task for the agent.');
  check(body.length <= MAX_TASK_PROMPT, 'Describe the task in under 20,000 characters.');
  check(b.title === undefined || b.title === null || typeof b.title === 'string', 'title must be text.');
  const given = typeof b.title === 'string' ? b.title.trim() : '';
  check(given.length <= MAX_TASK_TITLE, `Keep the title under ${MAX_TASK_TITLE} characters.`);
  const id = await newTask({ repoId, title: given || taskTitle(body), body, agent: taskAgent(b.agent, 'task'), browser: browserFlag(b.browser) });
  kick();
  res.status(202).json(taskView(id));
});

function taskOf(id: string) {
  const task = getTask(Number(id));
  check(task, 'Task not found.', 404);
  return task;
}

apiRouter.get('/tasks/:id', (req, res) => {
  res.json(taskView(taskOf(req.params.id).id));
});

/** Starts another agent on a task, with optional instructions. */
apiRouter.post('/tasks/:id/runs', async (req, res) => {
  const task = taskOf(req.params.id);
  const b = req.body ?? {};
  const agent = taskAgent(b.agent, null);
  check(b.prompt === undefined || b.prompt === null || typeof b.prompt === 'string', 'prompt must be text.');
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  check(prompt.length <= MAX_TASK_PROMPT, 'Keep the instructions under 20,000 characters.');
  const id = await startTaskRun({ task, agent, prompt: prompt || null, browser: browserFlag(b.browser) });
  kick();
  res.status(202).json(runView(id));
});

apiRouter.put('/tasks/:id/closed', (req, res) => {
  const task = taskOf(req.params.id);
  check(typeof req.body?.closed === 'boolean', 'closed must be true or false.');
  setTaskClosed(task.id, req.body.closed);
  res.json(taskView(task.id));
});

function pushableTicket(id: string) {
  const t = getTicket(Number(id));
  const repo = t && getRepo(t.repo_id);
  check(t && repo?.enabled && isAllowedAuthor(t.author), 'Ticket not found.', 404);
  return { t: t!, repo: repo! };
}

apiRouter.post('/tickets/:id/push', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  check(ticketInScope(t, repo), "This repository only works on nominated tickets. Nominate this ticket first.", 409);
  const scope = req.body?.scope;
  check(scope === 'stage' || scope === 'lifecycle', 'Choose "stage" or "lifecycle".');
  const refusal = pushRefusal({ labels: labelsOf(t), open: t.state === 'open', running: Boolean(activeRunId(t.id)) }, scope);
  check(!refusal, refusal ?? '', 409);
  setPush(t, scope);
  kick();
  res.json(ticketView(t, repo));
});

apiRouter.put('/tickets/:id/nominated', async (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const nominated = req.body?.nominated;
  check(typeof nominated === 'boolean', 'Say whether to nominate the ticket.');
  check(repo.selection === 'nominated', "This repository works on its whole backlog, so tickets don't need nominating.", 409);
  await editLabels(t, nominated ? [label.nominated] : [], nominated ? [] : [label.nominated]);
  if (nominated) kick();
  res.json(ticketView(t, repo));
});

apiRouter.put('/tickets/:id/dismissed', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const dismissed = req.body?.dismissed;
  check(typeof dismissed === 'boolean', 'Say whether to dismiss the ticket.');
  check(!dismissed || ticketView(t, repo).attention, "This ticket isn't waiting on you, so there's nothing to dismiss.", 409);
  setDismissed(t, dismissed);
  res.json(ticketView(t, repo));
});

apiRouter.put('/tickets/:id/prioritised', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const prioritised = req.body?.prioritised;
  check(typeof prioritised === 'boolean', 'Say whether to prioritise the ticket.');
  if (prioritised) {
    check(t.state === 'open', 'This ticket is closed.', 409);
    check(ticketInScope(t, repo), 'This repository only works on nominated tickets. Nominate this ticket first.', 409);
  }
  setPrioritised(t, prioritised);
  if (prioritised) kick();
  res.json(ticketView(t, repo));
});

apiRouter.delete('/tickets/:id/push', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  setPush(t, null);
  res.json(ticketView(t, repo));
});

apiRouter.put('/tickets/:id/state', async (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const b = req.body ?? {};
  const patch: TicketStatePatch = {};
  if ('stage' in b) {
    check(b.stage === null || STAGES.includes(b.stage), 'Choose a stage.');
    patch.stage = b.stage;
  }
  if ('size' in b) {
    check(b.size === null || SIZES.includes(b.size), 'Choose a size: XS, S, M, L or XL.');
    patch.size = b.size;
  }
  for (const key of ['needsInfo', 'skip', 'failed'] as const) {
    if (!(key in b)) continue;
    check(typeof b[key] === 'boolean', 'needsInfo, skip and failed must be true or false.');
    patch[key] = b[key];
  }
  check(Object.keys(patch).length, 'Send at least one of stage, size, needsInfo, skip or failed.');
  check(!activeRunId(t.id), 'An agent is working on this ticket. Stop it in the run view first.', 409);
  check(patch.stage !== 'reconcile' || t.rescue, "Workshop has no saved work to reconcile on this ticket. Choose another stage.");
  const { add, remove } = stateEdits(labelsOf(t), patch);
  try {
    await editLabels(t, add, remove);
  } catch (err) {
    throw new HttpError(502, `Couldn't update the labels on GitHub: ${(err as Error).message}`);
  }
  if (remove.includes(label.stage('reconcile'))) run('UPDATE tickets SET rescue = NULL WHERE id = ?', t.id);
  if (remove.includes(label.failed)) run('UPDATE tickets SET failures = 0 WHERE id = ?', t.id);
  kick();
  res.json(ticketView(t, repo));
});

apiRouter.post('/sync', (_req, res) => {
  syncSoon();
  res.status(202).json({ ok: true });
});

apiRouter.post('/refresh', (_req, res) => {
  void refreshNow();
  res.status(202).json({ ok: true });
});

function ticketParam(idParam: string) {
  check(/^[1-9]\d*$/.test(idParam), 'Ticket ids are whole numbers.');
  const t = getTicket(Number(idParam));
  check(t, 'Ticket not found.', 404);
  return t;
}

apiRouter.get('/tickets/:id', (req, res) => {
  const t = ticketParam(req.params.id);
  const body: TicketLifecycle = { ticket: ticketView(t, getRepo(t.repo_id)!), runs: ticketRunViews(t.id), media: listMedia(t.id).map(mediaView) };
  res.json(body);
});

apiRouter.get('/tickets/:id/media', (req, res) => {
  const t = ticketParam(req.params.id);
  const body: TicketMedia = { ticketId: t.id, ticket: `${getRepo(t.repo_id)!.full_name}#${t.number}`, title: t.title, items: listMedia(t.id).map(mediaView) };
  res.json(body);
});

apiRouter.get('/tickets/:id/media/:name', (req, res) => {
  const t = ticketParam(req.params.id);
  const name = req.params.name;
  check(validName(name), "That isn't a media file name.");
  const row = listMedia(t.id).find((m) => m.name === name);
  const type = extType(name);
  check(row && type, 'Image not found.', 404);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(mediaDir(t.id), name));
  } catch {
    throw new HttpError(404, 'Image not found.');
  }
  res.type(CONTENT_TYPES[type]);
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${name}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-cache',
  });
  res.send(bytes);
});

apiRouter.get('/runs', (req, res) => {
  const ticket = Number(req.query.ticket);
  res.json(ticket ? runViews('runs.ticket_id = ?', ticket) : runViews());
});

apiRouter.get('/runs/:id', (req, res) => {
  const view = runView(req.params.id);
  check(view, 'Run not found.', 404);
  res.json(view);
});

apiRouter.post('/runs/:id/stop', async (req, res) => {
  await stopRun(req.params.id, 'Stopped from Workshop.', true);
  res.json(runView(req.params.id));
});

apiRouter.post('/runs/:id/pause', (req, res) => {
  requestPause(req.params.id);
  res.json(runView(req.params.id));
});

apiRouter.post('/runs/:id/resume', (req, res) => {
  resumeNow(req.params.id);
  res.json(runView(req.params.id));
});

/**
 * The run's log as Server-Sent Events: everything so far, then live lines. Resumes from Last-Event-ID
 * or `?after=` (a fresh EventSource doesn't send the header). Ends with an `end` event, and closes,
 * once the run is no longer active, so a finished run doesn't hold a browser connection.
 */
apiRouter.get('/runs/:id/log', (req, res) => {
  const id = req.params.id;
  check(getRun(id), 'Run not found.', 404);
  const given = req.get('last-event-id') ?? req.query.after;
  const resume = typeof given === 'string' && /^\d+$/.test(given) ? Number(given) : -1;
  const after = resume;
  const onLine = (index: number, entry: LogEntry) => send(entry, index);
  let done = false;
  const finish = () => {
    if (done) return; // two publishes in one tick must not write after the response ended
    done = true;
    bus.off('topic', onTopic);
    send({}, undefined, 'end');
    res.end();
  };
  // setRun publishes 'runs' after the last line is appended, so `end` never cuts off the tail.
  const onTopic = (topic: string) => {
    if (topic !== 'runs') return;
    const r = getRun(id);
    if (!r || !ACTIVE_STATUSES.includes(r.status)) finish();
  };
  const send = openSse(res, () => {
    logBus.off(id, onLine);
    bus.off('topic', onTopic);
  });
  // readLog is synchronous, so no line can be appended between replaying the file and subscribing.
  readLog(id).forEach((entry, index) => {
    if (index > after) send(entry, index);
  });
  if (!ACTIVE_STATUSES.includes(getRun(id)!.status)) return finish();
  logBus.on(id, onLine);
  bus.on('topic', onTopic);
});

/** The run's log as a downloadable JSON Lines file, one entry per line, for analysis outside Workshop. */
apiRouter.get('/runs/:id/export', (req, res) => {
  const id = req.params.id;
  check(getRun(id), 'Run not found.', 404);
  res.type('application/x-ndjson');
  res.attachment(`workshop-run-${id}.jsonl`);
  res.send(readLog(id).map((e) => JSON.stringify(e) + '\n').join(''));
});

apiRouter.get('/alerts', (_req, res) => {
  res.json(alertViews('1 = 1', 200));
});

apiRouter.post('/alerts/:id/ack', (req, res) => {
  run('UPDATE alerts SET ack_at = ? WHERE id = ? AND ack_at IS NULL', Date.now(), Number(req.params.id));
  publish('alerts');
  res.json({ ok: true });
});

apiRouter.post('/alerts/ack-all', (_req, res) => {
  run('UPDATE alerts SET ack_at = ? WHERE ack_at IS NULL', Date.now());
  publish('alerts');
  res.json({ ok: true });
});

/** Tells the browser which data changed, so it refetches only those views. */
apiRouter.get('/events', (_req, res) => {
  const onTopic = (topic: string) => send({ topic });
  const send = openSse(res, () => bus.off('topic', onTopic));
  bus.on('topic', onTopic);
});
