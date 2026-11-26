import type { AgentName, Finding, Size } from '../api-types.ts';

export type { Finding };
import { CAPABILITIES, SIZES, type Capability } from './labels.ts';

export interface ClassifierResult {
  decision: 'accept' | 'reject' | 'needs_info' | 'blocked';
  size?: Size;
  reason: string;
  questions?: string[];
  blocked_by?: number[];
  capabilities?: Capability[];
  /** The ticket changes what a user sees, or is a bug best examined by running the app. */
  ui?: boolean;
}

export interface WorkResult {
  outcome: 'done' | 'needs_info' | 'failed';
  summary: string;
  questions?: string[];
  tests?: string;
  /** Images this run added to /work/media. */
  media?: { path: string; caption: string }[];
}

export const SEVERITIES = ['severe', 'moderate', 'minor'] as const;
export const CAUSES = ['design', 'implementation'] as const;

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
        },
        required: ['severity', 'cause', 'title', 'detail', 'evidence', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: [...WORK_SCHEMA.required, 'findings'],
};

/** A task run's result: the work result without media (tasks have no media store), and with nothing about tickets. */
const TASK_SCHEMA = {
  ...WORK_SCHEMA,
  properties: {
    outcome: WORK_SCHEMA.properties.outcome,
    summary: { type: 'string', description: 'Your report for the owner, in Markdown: what you did or found. When the task asks a question, the full answer.' },
    questions: { ...questions, description: 'Specific questions for the owner, who answers them when starting the next agent (needs_info only).' },
    tests: WORK_SCHEMA.properties.tests,
  },
};

/** The Code reviewer's result on a task: its findings, with the task's wording for the rest. */
const TASK_REVIEW_SCHEMA = {
  ...TASK_SCHEMA,
  properties: { ...TASK_SCHEMA.properties, findings: REVIEW_SCHEMA.properties.findings },
  required: [...TASK_SCHEMA.required, 'findings'],
};

/** The result schema for an agent working on a task. */
export const taskSchemaFor = (agent: AgentName) => (agent === 'code-review' ? TASK_REVIEW_SCHEMA : TASK_SCHEMA);

const SCHEMAS: Partial<Record<AgentName, object>> = { classifier: CLASSIFIER_SCHEMA, 'code-review': REVIEW_SCHEMA, task: TASK_SCHEMA };

export const schemaFor = (agent: AgentName) => SCHEMAS[agent] ?? WORK_SCHEMA;

const isStringList = (v: unknown) => Array.isArray(v) && v.every((q) => typeof q === 'string');
const isText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

function isFinding(v: unknown): v is Finding {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    SEVERITIES.includes(f.severity as Finding['severity']) &&
    CAUSES.includes(f.cause as Finding['cause']) &&
    [f.title, f.detail, f.evidence, f.fix].every(isText) &&
    (f.file === undefined || typeof f.file === 'string') &&
    (f.line === undefined || (Number.isInteger(f.line) && (f.line as number) > 0))
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
    if (v.decision === 'blocked') {
      const b = v.blocked_by;
      if (!Array.isArray(b) || !b.length || !b.every((n) => Number.isInteger(n) && n > 0)) return 'blocked requires blocked_by: the numbers of the tickets this one waits for.';
    }
    if (v.capabilities !== undefined && !(Array.isArray(v.capabilities) && v.capabilities.every((c) => CAPABILITIES.includes(c as Capability)))) return `capabilities must be a list of: ${CAPABILITIES.join(', ')}.`;
    if (v.ui !== undefined && typeof v.ui !== 'boolean') return 'ui must be true or false.';
    if (typeof v.reason !== 'string') return 'reason is required.';
    if (v.decision === 'accept' && !SIZES.includes(v.size as Size)) return 'size (xs–xl) is required to accept a ticket.';
    return v as unknown as ClassifierResult;
  }
  if (!['done', 'needs_info', 'failed'].includes(v.outcome as string)) return 'outcome must be done, needs_info or failed.';
  if (typeof v.summary !== 'string') return 'summary is required.';
  if (v.media !== undefined && !(Array.isArray(v.media) && v.media.every((m) => m && typeof m === 'object' && typeof m.path === 'string' && typeof m.caption === 'string'))) return 'media must be a list of { path, caption }.';
  if (agent === 'code-review' && (v.outcome === 'done' || v.findings !== undefined) && !(Array.isArray(v.findings) && v.findings.every(isFinding))) {
    return 'findings must be a list of { severity, cause, title, detail, evidence, fix }, with severity severe, moderate or minor and cause design or implementation.';
  }
  return v as unknown as WorkResult;
}
