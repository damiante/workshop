import type { AgentName, Size } from '../api-types.ts';
import { CAPABILITIES, SIZES, type Capability } from './labels.ts';

export interface ClassifierResult {
  decision: 'accept' | 'reject' | 'needs_info' | 'blocked';
  size?: Size;
  reason: string;
  questions?: string[];
  blocked_by?: number[];
  /** Prerequisite work no open ticket covers (blocked only). Workshop opens a ticket for each and waits for it. */
  raise_blockers?: Noticed[];
  capabilities?: Capability[];
  /** The ticket changes what a user sees, or is a bug best examined by running the app. */
  ui?: boolean;
}

/** Work an agent came across that is outside its ticket. Workshop opens a ticket for it. */
export interface Noticed {
  title: string;
  body: string;
}

/** At most this many tickets are opened from one run. */
export const MAX_NOTICED = 3;

/** The work agents that may stop on a prerequisite that has no ticket yet (`outcome: "blocked"`). */
export const BLOCKING_AGENTS: AgentName[] = ['design', 'implement'];

export interface WorkResult {
  outcome: 'done' | 'needs_info' | 'failed' | 'blocked';
  summary: string;
  questions?: string[];
  /** Only asked for in repositories that let agents open tickets. */
  noticed?: Noticed[];
  /** Prerequisite tickets to open and wait for (blocked only; `BLOCKING_AGENTS`). */
  raise_blockers?: Noticed[];
  /** Open tickets this one waits for (blocked only; `BLOCKING_AGENTS`). */
  blocked_by?: number[];
  tests?: string;
  /** Images this run added to /work/media. */
  media?: { path: string; caption: string }[];
}

export const SEVERITIES = ['severe', 'moderate', 'minor'] as const;
export const CAUSES = ['design', 'implementation'] as const;

/** One problem the Code reviewer found. */
export interface Finding {
  severity: (typeof SEVERITIES)[number];
  cause: (typeof CAUSES)[number];
  title: string;
  detail: string;
  /** How the reviewer checked it. */
  evidence: string;
  fix: string;
  file?: string;
  line?: number;
  /** A severe finding an earlier review this round sent the ticket back for, and it still holds. */
  repeat?: boolean;
}

export interface ReviewResult extends WorkResult {
  findings?: Finding[];
}

export type AgentResult = ClassifierResult | WorkResult | ReviewResult;

/** `tickets.rework`: automatic reworks this review round, and the severe findings to fix. */
export interface Rework {
  count: number;
  findings: Finding[];
  /** The handoff the review that sent it back saw. While it's still the current one, the rework hasn't happened. */
  handoffRunId?: string;
}

/** `tickets.handoff`: the Implementation result the pull request describes, kept until it opens. */
export interface Handoff {
  runId: string;
  result: WorkResult;
  /** The branch before and after the push. */
  before?: string;
  after?: string;
}

/** A run whose push was rescued: what to finish once the Merge agent has merged the saved work. */
export interface Rescue {
  /** The branch the agent's commits were saved on. */
  branch: string;
  runId: string;
  agent: AgentName;
  mode: 'normal' | 'delta';
  result: WorkResult;
}

const questions = { type: 'array', items: { type: 'string' }, description: 'Specific questions for the ticket owner (needs_info only).' };

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject', 'needs_info', 'blocked'] },
    size: { type: 'string', enum: SIZES, description: 'Required when decision is accept.' },
    reason: { type: 'string', description: 'One or two sentences explaining the decision and size.' },
    questions,
    capabilities: { type: 'array', items: { type: 'string', enum: CAPABILITIES }, description: "What the Implementation agent's container needs to test the change (accept only): browser for a web UI change that needs a screenshot or a browser test. Empty when nothing extra is needed." },
    ui: { type: 'boolean', description: 'Accept only: true when the ticket changes what a user sees, or is a bug best looked into by running the app (layout, rendering).' },
    blocked_by: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Numbers of the open tickets listed in the task that must be finished first (blocked only).' },
  },
  required: ['decision', 'reason'],
  additionalProperties: false,
};

const WORK_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'needs_info', 'failed'] },
    summary: { type: 'string', description: 'What you did, briefly. Posted to the ticket or pull request.' },
    questions,
    tests: { type: 'string', description: 'Which test suites ran and their result, e.g. "npm test: 214 passed".' },
    media: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string' } }, required: ['path', 'caption'], additionalProperties: false },
      description: 'Images this run added to /work/media/, each with a caption saying what it shows (up to 1000 characters; line breaks allowed).',
    },
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  ...WORK_SCHEMA,
  properties: {
    ...WORK_SCHEMA.properties,
    findings: {
      type: 'array',
      description: 'Every problem you found, each reported once. An empty list when there are none, or with needs_info or failed.',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: SEVERITIES,
            description:
              "severe: verified, glaring: doesn't do what the ticket asks, breaks existing behaviour, loses data, opens a security hole, crashes on an ordinary path, fails the repository's tests or type-check, or follows a design that can't work. moderate: a real bug on an edge path, a missing test, or a clear deviation from the conventions or design. minor: style, naming, small simplifications, comments and docs. When in doubt, it isn't severe.",
          },
          cause: { type: 'string', enum: CAUSES, description: "design when fixing it means changing the design document's approach; implementation when the code doesn't do what the design (or ticket) says." },
          title: { type: 'string', description: 'The problem in a few words.' },
          detail: { type: 'string', description: 'What is wrong and what goes wrong because of it.' },
          evidence: { type: 'string', description: 'How you checked it: the command you ran and what it printed, or the code you read. A few words are enough for minor findings.' },
          fix: { type: 'string', description: 'A concrete fix.' },
          file: { type: 'string', description: 'The file, relative to the repository root, when it applies.' },
          line: { type: 'integer', minimum: 1, description: 'The line in file, when it applies.' },
          repeat: { type: 'boolean', description: 'true only when an earlier code review sent the ticket back for this same problem (the findings listed above, or in Workshop\'s earlier send-back comments), and it still holds.' },
        },
        required: ['severity', 'cause', 'title', 'detail', 'evidence', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: [...WORK_SCHEMA.required, 'findings'],
};

const NOTICED_SCHEMA = {
  type: 'array',
  maxItems: MAX_NOTICED,
  description:
    "Real problems or needed work you came across that are outside this ticket: a bug somewhere else, something already broken that you didn't cause, a follow-up this change makes necessary. Don't fix them here. Workshop opens a ticket for each. Leave it empty for ideas, style, and anything this ticket should cover.",
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The ticket title: the problem in a few words.' },
      body: { type: 'string', description: 'What is wrong or needed, where (files, lines, how to see it), and why it matters. Written for someone who has not seen this ticket.' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
};

const RAISE_BLOCKERS_SCHEMA = {
  type: 'array',
  maxItems: MAX_NOTICED,
  description:
    "Prerequisite work this ticket can't be finished without, that is outside its scope and that no open ticket covers (blocked only). Workshop opens a ticket for each and waits for it.",
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The ticket title: the prerequisite work in a few words.' },
      body: { type: 'string', description: 'What has to be built and why this ticket needs it, where (files, interfaces), and how to tell it is done. Self-contained: written for someone who has not seen this ticket.' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
};

const SCHEMAS: Partial<Record<AgentName, { properties: object }>> = { classifier: CLASSIFIER_SCHEMA, 'code-review': REVIEW_SCHEMA };

/**
 * With `noticed`, every agent but the Classifier may also report work outside its ticket. With `blockers`, the
 * Classifier and `BLOCKING_AGENTS` may also return prerequisite tickets to open and wait for.
 */
export function schemaFor(agent: AgentName, opts: { noticed?: boolean; blockers?: boolean } = {}): object {
  const schema = SCHEMAS[agent] ?? WORK_SCHEMA;
  let properties: Record<string, unknown> = schema.properties as Record<string, unknown>;
  if (opts.noticed && agent !== 'classifier') properties = { ...properties, noticed: NOTICED_SCHEMA };
  if (opts.blockers && agent === 'classifier') {
    properties = {
      ...properties,
      blocked_by: { ...CLASSIFIER_SCHEMA.properties.blocked_by, description: 'Numbers of the open tickets listed in the task that must be finished first (blocked only; may be empty when raise_blockers is given).' },
      raise_blockers: RAISE_BLOCKERS_SCHEMA,
    };
  }
  if (opts.blockers && BLOCKING_AGENTS.includes(agent)) {
    properties = {
      ...properties,
      outcome: { type: 'string', enum: ['done', 'needs_info', 'failed', 'blocked'] },
      blocked_by: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Numbers of open tickets that must be finished first (blocked only).' },
      raise_blockers: RAISE_BLOCKERS_SCHEMA,
    };
  }
  return properties === schema.properties ? schema : { ...schema, properties };
}

const isStringList = (v: unknown) => Array.isArray(v) && v.every((q) => typeof q === 'string');
const isText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const isNumberList = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);
const isTextList = (v: unknown) => Array.isArray(v) && v.every((n) => n && typeof n === 'object' && isText(n.title) && isText(n.body));

function isFinding(v: unknown): v is Finding {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    SEVERITIES.includes(f.severity as Finding['severity']) &&
    CAUSES.includes(f.cause as Finding['cause']) &&
    [f.title, f.detail, f.evidence, f.fix].every(isText) &&
    (f.file === undefined || typeof f.file === 'string') &&
    (f.line === undefined || (Number.isInteger(f.line) && (f.line as number) > 0)) &&
    (f.repeat === undefined || typeof f.repeat === 'boolean')
  );
}

/** Validates the agent's structured output. Returns the result, or an error message. */
export function parseResult(agent: AgentName, value: unknown): AgentResult | string {
  if (!value || typeof value !== 'object') return 'The agent returned no structured result.';
  const v = value as Record<string, unknown>;
  if (v.questions !== undefined && !isStringList(v.questions)) return 'questions must be a list of strings.';
  const needsQuestions = v.decision === 'needs_info' || v.outcome === 'needs_info';
  if (needsQuestions && !(v.questions as string[] | undefined)?.length) return 'needs_info requires at least one question.';
  if (agent === 'classifier') {
    if (!['accept', 'reject', 'needs_info', 'blocked'].includes(v.decision as string)) return 'decision must be accept, reject, needs_info or blocked.';
    if (v.raise_blockers !== undefined && !isTextList(v.raise_blockers)) return 'raise_blockers must be a list of { title, body }.';
    if (v.decision === 'blocked') {
      const b = v.blocked_by;
      if (b !== undefined && !isNumberList(b)) return 'blocked_by must be a list of ticket numbers.';
      if (!(b as number[] | undefined)?.length && !(v.raise_blockers as Noticed[] | undefined)?.length) {
        return 'blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).';
      }
    }
    if (v.capabilities !== undefined && !(Array.isArray(v.capabilities) && v.capabilities.every((c) => CAPABILITIES.includes(c as Capability)))) return `capabilities must be a list of: ${CAPABILITIES.join(', ')}.`;
    if (v.ui !== undefined && typeof v.ui !== 'boolean') return 'ui must be true or false.';
    if (typeof v.reason !== 'string') return 'reason is required.';
    if (v.decision === 'accept' && !SIZES.includes(v.size as Size)) return 'size (xs–xl) is required to accept a ticket.';
    return v as unknown as ClassifierResult;
  }
  const blocking = BLOCKING_AGENTS.includes(agent);
  if (!['done', 'needs_info', 'failed', ...(blocking ? ['blocked'] : [])].includes(v.outcome as string)) {
    return blocking ? 'outcome must be done, needs_info, failed or blocked.' : 'outcome must be done, needs_info or failed.';
  }
  if (typeof v.summary !== 'string') return 'summary is required.';
  if (v.media !== undefined && !(Array.isArray(v.media) && v.media.every((m) => m && typeof m === 'object' && typeof m.path === 'string' && typeof m.caption === 'string'))) return 'media must be a list of { path, caption }.';
  if (v.noticed !== undefined && !isTextList(v.noticed)) return 'noticed must be a list of { title, body }.';
  if (v.raise_blockers !== undefined && !isTextList(v.raise_blockers)) return 'raise_blockers must be a list of { title, body }.';
  if (v.blocked_by !== undefined && !isNumberList(v.blocked_by)) return 'blocked_by must be a list of ticket numbers.';
  if (v.outcome === 'blocked' && !(v.blocked_by as number[] | undefined)?.length && !(v.raise_blockers as Noticed[] | undefined)?.length) {
    return 'blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).';
  }
  if (agent === 'code-review' && (v.outcome === 'done' || v.findings !== undefined) && !(Array.isArray(v.findings) && v.findings.every(isFinding))) {
    return 'findings must be a list of { severity, cause, title, detail, evidence, fix }, with severity severe, moderate or minor and cause design or implementation.';
  }
  return v as unknown as WorkResult;
}
