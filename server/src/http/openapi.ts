import { config } from '../config.ts';

// Hand-written OpenAPI 3.1 description of `apiRouter`. A test checks that every route is listed
// and that the main responses' top-level fields match, so add new routes here.

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema): Schema => ({ type: 'array', items });
const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const num: Schema = { type: 'number' };
const bool: Schema = { type: 'boolean' };
const nullable = (s: Schema): Schema => ({ oneOf: [s, { type: 'null' }] });
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });

const schemas: Record<string, Schema> = {
  Error: object({ error: str }),
  Ok: object({ ok: bool }),
  Mode: enumOf('paused', 'scheduled', 'always'),
  TicketOrder: enumOf('updated-asc', 'updated-desc', 'created-asc', 'created-desc'),
  Billing: enumOf('subscription', 'api'),
  Stage: enumOf('design', 'design-review', 'implement', 'code-review', 'pr-review', 'merge', 'reclassify', 'reconcile'),
  Size: enumOf('xs', 's', 'm', 'l', 'xl'),
  AgentName: enumOf('classifier', 'design', 'design-review', 'implement', 'code-review', 'merge'),
  RunStatus: enumOf('starting', 'running', 'publishing', 'paused', 'succeeded', 'failed', 'cancelled', 'lost'),
  Settings: object({
    mode: ref('Mode'),
    ticketOrder: ref('TicketOrder'),
    timezone: str,
    days: array(int),
    start: str,
    end: str,
    apiRunCapUsd: num,
    apiDailyCapUsd: num,
    pollMinutes: int,
    authors: array(str),
    retentionDays: int,
  }),
  Limits: object({ fiveHour: num, weekly: num }),
  UsageWindow: object({ pct: num, resetsAt: nullable(int) }),
  AllowanceView: object({
    connectionId: int,
    connectionName: str,
    fiveHour: nullable(ref('UsageWindow')),
    sevenDay: nullable(ref('UsageWindow')),
    sampledAt: nullable(int),
    blockedUntil: nullable(int),
    unknown: bool,
    tokens: object({ fiveHour: int, sevenDay: int }),
    limits: ref('Limits'),
  }),
  Usage: object({
    allowance: array(ref('AllowanceView')),
    apiSpendTodayUsd: num,
    apiRunCapUsd: num,
    apiDailyCapUsd: num,
  }),
  SpendTotals: object({ runs: int, inputTokens: int, outputTokens: int, costUsd: num }),
  LifetimeSpend: object({
    since: nullable(int),
    total: ref('SpendTotals'),
    subscription: ref('SpendTotals'),
    api: ref('SpendTotals'),
    byModel: array({ allOf: [ref('SpendTotals'), object({ model: str })] }),
    byProject: array({ allOf: [ref('SpendTotals'), object({ project: nullable(str) })] }),
    byConnection: array({ allOf: [ref('SpendTotals'), object({ connectionId: nullable(int), connection: nullable(str), billing: str })] }),
    byMonth: array({ allOf: [ref('SpendTotals'), object({ month: str })] }),
  }),
  TicketSpend: object({ repo: str, number: int, title: nullable(str), url: nullable(str), runs: int, inputTokens: int, outputTokens: int, costUsd: num }),
  SpendSeries: object({ key: str, name: str, points: array(ref('SpendTotals')), totals: ref('SpendTotals') }),
  WindowProjection: object({ pct: num, resetsAt: int, ratePerHour: num, limitAt: nullable(int), fullAt: nullable(int), over: bool }),
  Burn: object({ usd: num, tokens: num }),
  BurnRate: object({ fiveHours: ref('Burn'), day: ref('Burn'), perDay: ref('Burn') }),
  BacklogPool: object({
    usd: num,
    tokens: num,
    perHourUsd: num,
    finishAt: nullable(int),
    unlimitedAt: nullable(int),
    limitedBy: nullable(enumOf('five-hour', 'weekly', 'daily')),
    reason: nullable(enumOf('no-pace', 'no-subscription', 'api-off', 'beyond')),
    curve: array({ type: 'array', items: num, minItems: 2, maxItems: 2, description: '[time, fraction of the work left]' }),
    unsized: array(str),
    unmetered: array(str),
  }),
  BacklogProjection: object({
    tickets: int,
    byStage: array(object({ stage: { oneOf: [ref('Stage'), enumOf('new')] }, count: int })),
    unestimated: int,
    basis: int,
    subscription: nullable(ref('BacklogPool')),
    api: nullable(ref('BacklogPool')),
    finishAt: nullable(int),
  }),
  AllowanceHistory: object({
    connectionId: int,
    connectionName: str,
    limits: ref('Limits'),
    samples: array(object({ ts: int, fiveHour: nullable(num), sevenDay: nullable(num) })),
    sampledAt: nullable(int),
    blockedUntil: nullable(int),
    unknown: bool,
    fiveHour: nullable(ref('WindowProjection')),
    sevenDay: nullable(ref('WindowProjection')),
    burn: ref('BurnRate'),
  }),
  UsageHistory: object({
    range: enumOf('24h', '7d', '30d', '90d', 'all'),
    bucket: enumOf('hour', 'day', 'month'),
    buckets: array(str),
    byBilling: array(ref('SpendSeries')),
    byModel: array(ref('SpendSeries')),
    byProject: array(ref('SpendSeries')),
    byConnection: array(ref('SpendSeries')),
    byTicket: array(ref('TicketSpend')),
    allowance: array(ref('AllowanceHistory')),
    projection: object({
      api: object({ todayUsd: num, dailyCapUsd: num, capAt: nullable(int), perDayUsd: num, monthToDateUsd: num, monthEndUsd: num, burn: ref('BurnRate') }),
      subscription: object({ perDayUsd: num, perDayTokens: num, monthToDateUsd: num, monthEndUsd: num, burn: ref('BurnRate') }),
      backlog: ref('BacklogProjection'),
    }),
  }),
  RunView: object({
    id: str,
    ticketId: int,
    ticket: str,
    ticketTitle: str,
    ticketUrl: str,
    agent: ref('AgentName'),
    mode: enumOf('normal', 'delta'),
    attempt: int,
    environment: nullable(str),
    model: str,
    billing: ref('Billing'),
    status: ref('RunStatus'),
    step: nullable(str),
    summary: nullable(str),
    activity: nullable(str),
    error: nullable(str),
    inputTokens: nullable(int),
    outputTokens: nullable(int),
    costUsd: nullable(num),
    startedAt: int,
    endedAt: nullable(int),
    resetsAt: nullable(int),
    pauseReason: nullable(enumOf('limit', 'threshold', 'manual', 'connection')),
    pauseRequested: bool,
    mediaCount: int,
    maxTurns: nullable(int),
    timeoutMin: nullable(int),
    stepStartedAt: nullable(int),
    publishRetryAt: nullable(int),
  }),
  TicketView: object({
    id: int,
    repo: str,
    number: int,
    title: str,
    url: str,
    author: str,
    state: enumOf('open', 'closed'),
    labels: array(str),
    size: nullable(ref('Size')),
    stage: nullable(ref('Stage')),
    needsInfo: bool,
    skipped: bool,
    failed: bool,
    next: nullable(str),
    branch: nullable(str),
    prNumber: nullable(int),
    prUrl: nullable(str),
    prStatus: nullable(str),
    activeRunId: nullable(str),
    attention: nullable(enumOf('question', 'failed', 'review')),
    dismissed: bool,
    push: nullable(enumOf('stage', 'lifecycle')),
    nominated: nullable(bool),
    prioritised: bool,
    bypassLimits: bool,
    mediaCount: int,
    updatedAt: str,
  }),
  DependencyNode: object({
    ref: { ...str, description: '"#12", or "other/repo#5" for a ticket in another repository.' },
    number: int,
    title: nullable(str),
    url: str,
    state: enumOf('open', 'closed'),
    ticket: { ...nullable(ref('TicketView')), description: "Null when the ticket isn't in Workshop (another repository, or an author Workshop doesn't work for)." },
  }),
  DependencyEdge: { ...object({ blocker: str, ticket: str }), description: '`blocker` must finish before `ticket`; both are node refs.' },
  DependencyGraph: object({ repoId: int, repo: str, nodes: array(ref('DependencyNode')), edges: array(ref('DependencyEdge')) }),
  MediaItem: object({ name: str, source: str, runId: nullable(str), caption: nullable(str), size: int, createdAt: int, url: str }),
  TicketLifecycle: object({ ticket: ref('TicketView'), runs: array(ref('RunView')), media: array(ref('MediaItem')) }),
  TicketMedia: object({ ticketId: int, ticket: str, title: str, items: array(ref('MediaItem')) }),
  TicketStatePatch: object(
    {
      stage: { ...nullable(ref('Stage')), description: 'The ticket\'s stage. null removes the stage label.' },
      size: { ...nullable(ref('Size')), description: 'The ticket\'s size. null removes the size label.' },
      needsInfo: { ...bool, description: 'Whether the ticket is waiting for an answer from the owner.' },
      skip: { ...bool, description: 'Whether Workshop should leave the ticket alone.' },
      failed: { ...bool, description: 'Whether the ticket has failed. Setting it to false also resets the attempt count so the ticket can run again.' },
    },
    [],
  ),
  HostView: object({ id: int, name: str, status: enumOf('ok', 'error', 'unknown'), available: bool, slots: int, busy: int, pools: nullable(array(object({ size: enumOf('small', 'standard', 'large'), slots: int, busy: int }))), specs: nullable(str) }),
  QueueItem: object({ ticketId: int, ticket: str, title: str, next: str, blockedBy: nullable(str), push: nullable(enumOf('stage', 'lifecycle')), prioritised: bool, bypassLimits: bool }),
  AlertView: object({
    id: int,
    level: enumOf('error', 'warning', 'info'),
    kind: str,
    message: str,
    ref: nullable(str),
    runId: nullable(str),
    createdAt: int,
    ackAt: nullable(int),
  }),
  Overview: object({
    mode: ref('Mode'),
    withinHours: bool,
    allowance: array(ref('AllowanceView')),
    running: array(ref('RunView')),
    publishWaiting: array(ref('RunView')),
    needsYou: array(ref('TicketView')),
    dismissed: array(ref('TicketView')),
    queue: array(ref('QueueItem')),
    hosts: array(ref('HostView')),
    alerts: array(ref('AlertView')),
  }),
  AgentClassView: object({
    name: ref('AgentName'),
    label: str,
    description: str,
    model: nullable(str),
    modelConnectionId: nullable(int),
    effort: nullable(str),
    billing: ref('Billing'),
    prompt: str,
    defaultPrompt: str,
    customised: bool,
    protocol: str,
    maxTurns: int,
    timeoutMin: int,
  }),
  ModelOption: object({ connectionId: int, connectionName: str, id: str, label: str, billing: array(ref('Billing')) }),
  LogEntry: object({ step: enumOf('prepare', 'run', 'publish', 'workshop'), stream: enumOf('stdout', 'stderr'), text: str, container: str }, ['step', 'stream', 'text']),
};

const content = (schema: Schema) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({ description, content: content(ref('Error')) });
const ERRORS: Record<string, string> = {
  400: 'The request was invalid.',
  401: 'Missing, wrong or revoked credentials.',
  403: 'The token is read-only, or the request came from another site.',
  404: 'Not found.',
  409: 'Workshop cannot do that right now.',
  502: 'GitHub refused the change.',
};

interface Op {
  summary: string;
  ok?: Schema;
  status?: string;
  body?: Schema;
  errors?: number[];
  params?: string[];
  query?: Record<string, string>;
  stream?: string;
  /** Content type of a `stream` response; event-stream by default. */
  streamType?: string;
}

function operation(method: string, op: Op) {
  const responses: Record<string, unknown> = {
    [op.status ?? '200']: op.stream
      ? { description: op.stream, content: { [op.streamType ?? 'text/event-stream']: { schema: str } } }
      : { description: 'Success.', content: content(op.ok ?? ref('Ok')) },
    401: errorResponse(ERRORS[401]),
  };
  for (const code of op.errors ?? []) responses[code] = errorResponse(ERRORS[code]);
  return {
    summary: op.summary,
    ...(method === 'get' ? {} : { 'x-workshop-scope': 'write' }),
    parameters: [
      ...(op.params ?? []).map((name) => ({ name, in: 'path', required: true, schema: str })),
      ...Object.entries(op.query ?? {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: str })),
    ],
    ...(op.body ? { requestBody: { required: true, content: content(op.body) } } : {}),
    responses,
  };
}

const paths: Record<string, Record<string, Op>> = {
  '/overview': { get: { summary: 'Status: mode, running agents, queue, hosts, allowance and open alerts.', ok: ref('Overview') } },
  '/usage': { get: { summary: 'Claude allowance and limits per subscription, and today\'s API spend against the caps.', ok: ref('Usage') } },
  '/usage/limits/{connectionId}': {
    put: {
      summary: "Changes a Claude subscription's 5-hour and weekly limits (percentages, 0 to 100). Send only the ones to change.",
      params: ['connectionId'],
      body: { type: 'object', properties: (schemas.Limits as { properties: Record<string, Schema> }).properties },
      ok: ref('AllowanceView'),
      errors: [400, 403, 404],
    },
  },
  '/usage/lifetime': { get: { summary: "Lifetime token use and token-equivalent cost of Workshop's agent runs, by billing, model, project and month.", ok: ref('LifetimeSpend') } },
  '/usage/history': {
    get: {
      summary:
        "Token use and token-equivalent cost over time (hours for the last 24 hours, days, or months for all time), as one series per billing, model, project and connection, the tickets that used the most, plus each subscription's readings over the last 7 days and projections: when each usage window reaches your limit, when API spend reaches the daily limit, and month-end totals.",
      query: { range: '24h, 7d, 30d (the default), 90d or all.' },
      ok: ref('UsageHistory'),
      errors: [400],
    },
  },
  '/openapi.json': { get: { summary: 'This document.', ok: { type: 'object' } } },
  '/settings': {
    get: { summary: 'Operating settings.', ok: ref('Settings') },
    put: { summary: 'Changes the settings you send; the rest stay as they are. Send {"mode":"paused"} to stop automatic starts.', body: { type: 'object', properties: (schemas.Settings as { properties: Record<string, Schema> }).properties }, ok: ref('Settings'), errors: [400, 403] },
  },
  '/agents': { get: { summary: 'Agent classes and their model settings and prompts.', ok: array(ref('AgentClassView')) } },
  '/agents/{name}': {
    put: { summary: 'Changes one agent class. Send only the fields to change.', params: ['name'], body: { type: 'object' }, ok: ref('AgentClassView'), errors: [400, 403, 404] },
  },
  '/hosts/{id}': {
    put: {
      summary: 'Switches an agent host on or off for new agents. A host that is off stays connected and its running agents carry on.',
      params: ['id'],
      body: object({ available: bool }),
      ok: ref('HostView'),
      errors: [400, 403, 404],
    },
  },
  '/models': { get: { summary: 'Models each Claude connection offers.', ok: array(ref('ModelOption')) } },
  '/dependencies': { get: { summary: 'Every "blocked by" link Workshop knows of, open and closed, as one graph per enabled repository.', ok: array(ref('DependencyGraph')) } },
  '/tickets': { get: { summary: 'Tickets Workshop knows about.', query: { closed: 'Send 1 to include closed tickets.' }, ok: array(ref('TicketView')) } },
  '/tickets/{id}/launch': {
    post: {
      summary: 'Starts an agent on the ticket now, ignoring the operation mode and hours. Dependencies, model, allowance, API cap and host gates still apply.',
      params: ['id'],
      status: '202',
      ok: ref('RunView'),
      errors: [400, 403, 404, 409],
    },
  },
  '/tickets/{id}/push': {
    post: {
      summary: 'Pushes the ticket by hand: it runs even while Workshop is paused or outside hours. Send scope "stage" or "lifecycle".',
      params: ['id'],
      body: { type: 'object' },
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409],
    },
    delete: { summary: 'Cancels a push.', params: ['id'], ok: ref('TicketView'), errors: [403, 404] },
  },
  '/tickets/{id}/state': {
    put: {
      summary: "Sets the ticket's stage, size or flags by changing its workshop labels on GitHub. Send only the fields to change; stage and size may be null to clear them. Clearing failed also resets the attempt count. Refused (409) while an agent works on the ticket or its run is paused; GitHub rejecting the change gives 502.",
      params: ['id'],
      body: ref('TicketStatePatch'),
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409, 502],
    },
  },
  '/tickets/{id}/nominated': {
    put: {
      summary: 'Nominates or un-nominates a ticket in a repository that only works on nominated tickets. Send { "nominated": true | false }.',
      params: ['id'],
      body: { type: 'object' },
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409],
    },
  },
  '/tickets/{id}/dismissed': {
    put: {
      summary:
        'Dismisses a ticket from Needs you on the dashboard, or brings it back. Send { "dismissed": true | false }. It comes back by itself when the reason changes: a new question, failure or pull request to review. Changes nothing on GitHub.',
      params: ['id'],
      body: object({ dismissed: bool }),
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409],
    },
  },
  '/tickets/{id}/prioritised': {
    put: {
      summary:
        'Puts the ticket ahead of every ticket you haven\'t prioritised, for its whole lifecycle, or removes that. Send { "prioritised": true | false }. Workshop\'s mode and hours still apply. Cleared when the ticket closes.',
      params: ['id'],
      body: object({ prioritised: bool }),
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409],
    },
  },
  '/tickets/{id}/bypass-limits': {
    put: {
      summary:
        'Lets this ticket\'s agents start, run and resume past your subscription usage limits for its whole lifecycle, or removes that. Send { "bypassLimits": true | false }. Limits Claude reports, the API daily cap, mode and hours still apply. Cleared when the ticket closes.',
      params: ['id'],
      body: object({ bypassLimits: bool }),
      ok: ref('TicketView'),
      errors: [400, 403, 404, 409],
    },
  },
  '/tickets/{id}': { get: { summary: "A ticket with every agent run on it, oldest first, and its media: the ticket's lifecycle in Workshop.", params: ['id'], ok: ref('TicketLifecycle'), errors: [400, 404] } },
  '/tickets/{id}/media': { get: { summary: "The images in the ticket's media store: screenshots agents added and images copied from the issue.", params: ['id'], ok: ref('TicketMedia'), errors: [400, 404] } },
  '/tickets/{id}/media/{name}': {
    get: {
      summary: 'One image from the ticket\'s media store, with its own Content-Type (image/png, image/jpeg, image/gif or image/webp).',
      params: ['id', 'name'],
      stream: 'The image file.',
      streamType: 'image/*',
      errors: [400, 404],
    },
  },
  '/sync': { post: { summary: 'Asks Workshop to sync tickets from GitHub soon.', status: '202', errors: [403] } },
  '/refresh': {
    post: {
      summary:
        "Runs the checks Workshop's timer runs, now: syncs tickets from GitHub, re-reads the Claude usage of subscriptions that are over your limits or haven't been checked recently, then starts or resumes whatever is ready. Answers at once; the checks finish in the background.",
      status: '202',
      errors: [403],
    },
  },
  '/runs': { get: { summary: 'Agent runs, newest first.', query: { ticket: 'Only runs for this ticket id.' }, ok: array(ref('RunView')) } },
  '/runs/{id}': { get: { summary: 'One run.', params: ['id'], ok: ref('RunView'), errors: [404] } },
  '/runs/{id}/stop': { post: { summary: 'Stops a run.', params: ['id'], ok: ref('RunView'), errors: [403, 404] } },
  '/runs/{id}/pause': {
    post: {
      summary: "Pauses a run at its next turn boundary and frees its host slot. It stays paused until you resume it. On a run paused for usage, it stays paused after the limit resets.",
      params: ['id'],
      ok: ref('RunView'),
      errors: [403, 404, 409],
    },
  },
  '/runs/{id}/resume': {
    post: {
      summary: "Resumes a run you paused, in the same Claude session, ignoring the operation mode and hours. Needs a free slot on the run's host and enough Claude allowance. On a run that hasn't stopped yet, cancels the pause.",
      params: ['id'],
      ok: ref('RunView'),
      errors: [403, 404, 409],
    },
  },
  '/runs/{id}/log': {
    get: {
      summary: 'The run log as server-sent events: everything so far, then live lines. Each event is a LogEntry; the event id is the line index (send Last-Event-ID or ?after=<index> to resume). Once the run is no longer active the stream sends an `end` event and closes.',
      params: ['id'],
      stream: 'A stream of LogEntry JSON objects.',
      errors: [404],
    },
  },
  '/runs/{id}/export': {
    get: {
      summary: 'The run log as a downloadable JSON Lines file (application/x-ndjson): one LogEntry per line.',
      params: ['id'],
      stream: 'A JSON Lines file of LogEntry objects.',
      errors: [404],
    },
  },
  '/alerts': { get: { summary: 'Recent alerts.', ok: array(ref('AlertView')) } },
  '/alerts/{id}/ack': { post: { summary: 'Acknowledges an alert.', params: ['id'], errors: [403] } },
  '/alerts/ack-all': { post: { summary: 'Acknowledges every open alert.', errors: [403] } },
  '/events': { get: { summary: 'Server-sent events naming the topics whose data changed ({"topic":"runs"}), plus a `ping` event when it opens and every 15 seconds.', stream: 'A stream of {"topic": string} objects.' } },
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Workshop',
    version: config.version,
    description:
      'Workshop\'s HTTP API. Authenticate with `Authorization: Bearer wks_…` (create a token in Settings) or the web session cookie. ' +
      'Read-only tokens may only use GET. Tokens may expire; an expired token gets 401. Connections and API tokens can only be managed from a signed-in browser session, so they are not described here.',
  },
  servers: [{ url: '/api' }],
  security: [{ bearer: [] }, { session: [] }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: 'An API token from Settings.' },
      session: { type: 'apiKey', in: 'cookie', name: 'workshop_session' },
    },
    schemas,
  },
  paths: Object.fromEntries(Object.entries(paths).map(([path, ops]) => [path, Object.fromEntries(Object.entries(ops).map(([method, op]) => [method, operation(method, op)]))])),
};
