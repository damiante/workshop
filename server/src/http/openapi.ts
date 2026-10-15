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
  Billing: enumOf('subscription', 'api'),
  Stage: enumOf('design', 'design-review', 'implement', 'pr-review', 'merge', 'reclassify'),
  Size: enumOf('xs', 's', 'm', 'l', 'xl'),
  AgentName: enumOf('classifier', 'design', 'design-review', 'implement', 'merge'),
  RunStatus: enumOf('starting', 'running', 'publishing', 'paused', 'succeeded', 'failed', 'cancelled', 'lost'),
  Settings: object({
    mode: ref('Mode'),
    timezone: str,
    days: array(int),
    start: str,
    end: str,
    fiveHourMax: num,
    weeklyMax: num,
    apiRunCapUsd: num,
    apiDailyCapUsd: num,
    pollMinutes: int,
    authors: array(str),
    retentionDays: int,
  }),
  UsageWindow: object({ pct: num, resetsAt: nullable(int) }),
  AllowanceView: object({
    connectionId: int,
    connectionName: str,
    fiveHour: nullable(ref('UsageWindow')),
    sevenDay: nullable(ref('UsageWindow')),
    sampledAt: nullable(int),
    blockedUntil: nullable(int),
  }),
  Usage: object({
    allowance: array(ref('AllowanceView')),
    thresholds: object({ fiveHour: num, weekly: num }),
    apiSpendTodayUsd: num,
    apiRunCapUsd: num,
    apiDailyCapUsd: num,
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
    push: nullable(enumOf('stage', 'lifecycle')),
    nominated: nullable(bool),
    updatedAt: str,
  }),
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
  HostView: object({ id: int, name: str, status: enumOf('ok', 'error', 'unknown'), available: bool, slots: int, busy: int, specs: nullable(str) }),
  QueueItem: object({ ticketId: int, ticket: str, title: str, next: str, blockedBy: nullable(str) }),
  AlertView: object({
    id: int,
    level: enumOf('error', 'warning', 'info'),
    kind: str,
    message: str,
    ref: nullable(str),
    createdAt: int,
    ackAt: nullable(int),
  }),
  Overview: object({
    mode: ref('Mode'),
    withinHours: bool,
    allowance: array(ref('AllowanceView')),
    thresholds: object({ fiveHour: num, weekly: num }),
    running: array(ref('RunView')),
    needsYou: array(ref('TicketView')),
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
}

function operation(method: string, op: Op) {
  const responses: Record<string, unknown> = {
    [op.status ?? '200']: op.stream
      ? { description: op.stream, content: { 'text/event-stream': { schema: str } } }
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
  '/usage': { get: { summary: 'Claude allowance per connection, the thresholds, and today\'s API spend against the caps.', ok: ref('Usage') } },
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
  '/sync': { post: { summary: 'Asks Workshop to sync tickets from GitHub soon.', status: '202', errors: [403] } },
  '/runs': { get: { summary: 'Agent runs, newest first.', query: { ticket: 'Only runs for this ticket id.' }, ok: array(ref('RunView')) } },
  '/runs/{id}': { get: { summary: 'One run.', params: ['id'], ok: ref('RunView'), errors: [404] } },
  '/runs/{id}/stop': { post: { summary: 'Stops a run.', params: ['id'], ok: ref('RunView'), errors: [403, 404] } },
  '/runs/{id}/log': {
    get: {
      summary: 'The run log as server-sent events: everything so far, then live lines. Each event is a LogEntry; the event id is the line index (send Last-Event-ID or ?after=<index> to resume). Once the run is no longer active the stream sends an `end` event and closes.',
      params: ['id'],
      stream: 'A stream of LogEntry JSON objects.',
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
      'Read-only tokens may only use GET. Connections and API tokens can only be managed from a signed-in browser session, so they are not described here.',
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
