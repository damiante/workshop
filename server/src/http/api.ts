import { Router } from 'express';
import { agentViews, updateAgent } from '../agents.ts';
import { allowanceViews } from '../allowance.ts';
import type { AgentClassView, AgentName, AlertView, LogEntry, ModelOption, Overview, Settings } from '../api-types.ts';
import { all, run } from '../db.ts';
import { bus, openSse, publish } from '../events.ts';
import { getConnection, listConnections, modelsOf } from '../providers/index.ts';
import { getRun, logBus, readLog, runView, runViews } from '../runs.ts';
import { pushRefusal, withinHours } from '../scheduler/gates.ts';
import { hostViews, kick, queueView, syncSoon } from '../scheduler/loop.ts';
import { stopRun } from '../scheduler/runner.ts';
import { getSettings, saveSettings } from '../settings.ts';
import { activeRunId, editLabels, getRepo, getTicket, isAllowedAuthor, labelsOf, listTicketViews, setPush, ticketInScope, ticketView } from '../tickets.ts';
import { label } from '../workflow/labels.ts';
import { AGENT_NAMES } from '../workflow/prompts.ts';
import { check, int, num } from './util.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function alertViews(where: string, limit: number): AlertView[] {
  return all<{ id: number; level: AlertView['level']; kind: string; message: string; ref: string | null; created_at: number; ack_at: number | null }>(
    `SELECT * FROM alerts WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
    limit,
  ).map((a) => ({ id: a.id, level: a.level, kind: a.kind, message: a.message, ref: a.ref, createdAt: a.created_at, ackAt: a.ack_at }));
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
  const overview: Overview = {
    mode: s.mode,
    withinHours: withinHours(s, new Date()),
    allowance: allowanceViews(),
    thresholds: { fiveHour: s.fiveHourMax, weekly: s.weeklyMax },
    running: runViews("runs.status IN ('starting', 'running', 'publishing', 'paused')"),
    needsYou: tickets.filter((t) => t.needsInfo || t.failed || (t.stage === 'pr-review' && !t.activeRunId)),
    queue: queueView(),
    hosts: hostViews(),
    alerts: alertViews('ack_at IS NULL', 20),
  };
  res.json(overview);
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
  if (b.fiveHourMax !== undefined) patch.fiveHourMax = num(b.fiveHourMax, '5-hour limit', 0, 100);
  if (b.weeklyMax !== undefined) patch.weeklyMax = num(b.weeklyMax, 'Weekly limit', 0, 100);
  if (b.apiRunCapUsd !== undefined) patch.apiRunCapUsd = num(b.apiRunCapUsd, 'API cap per run', 0, 1000);
  if (b.apiDailyCapUsd !== undefined) patch.apiDailyCapUsd = num(b.apiDailyCapUsd, 'API cap per day', 0, 10000);
  if (b.pollMinutes !== undefined) patch.pollMinutes = int(b.pollMinutes, 'Polling interval', 1, 60);
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

apiRouter.delete('/tickets/:id/push', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  setPush(t, null);
  res.json(ticketView(t, repo));
});

apiRouter.post('/sync', (_req, res) => {
  syncSoon();
  res.status(202).json({ ok: true });
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

/** The run's log as Server-Sent Events: everything so far, then live lines. Resumes from Last-Event-ID. */
apiRouter.get('/runs/:id/log', (req, res) => {
  const id = req.params.id;
  check(getRun(id), 'Run not found.', 404);
  const after = Number(req.get('last-event-id') ?? -1);
  const onLine = (index: number, entry: LogEntry) => send(entry, index);
  const send = openSse(res, () => logBus.off(id, onLine));
  // readLog is synchronous, so no line can be appended between replaying the file and subscribing.
  readLog(id).forEach((entry, index) => {
    if (index > after) send(entry, index);
  });
  logBus.on(id, onLine);
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
