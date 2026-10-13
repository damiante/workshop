import type { AgentName, Size } from '../api-types.ts';
import { SIZES } from './labels.ts';

export interface ClassifierResult {
  decision: 'accept' | 'reject' | 'needs_info';
  size?: Size;
  reason: string;
  questions?: string[];
}

export interface WorkResult {
  outcome: 'done' | 'needs_info' | 'failed';
  summary: string;
  questions?: string[];
  tests?: string;
}

export type AgentResult = ClassifierResult | WorkResult;

const questions = { type: 'array', items: { type: 'string' }, description: 'Specific questions for the ticket owner (needs_info only).' };

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject', 'needs_info'] },
    size: { type: 'string', enum: SIZES, description: 'Required when decision is accept.' },
    reason: { type: 'string', description: 'One or two sentences explaining the decision and size.' },
    questions,
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
  },
  required: ['outcome', 'summary'],
  additionalProperties: false,
};

export const schemaFor = (agent: AgentName) => (agent === 'classifier' ? CLASSIFIER_SCHEMA : WORK_SCHEMA);

const isStringList = (v: unknown) => Array.isArray(v) && v.every((q) => typeof q === 'string');

/** Validates the agent's structured output. Returns the result, or an error message. */
export function parseResult(agent: AgentName, value: unknown): AgentResult | string {
  if (!value || typeof value !== 'object') return 'The agent returned no structured result.';
  const v = value as Record<string, unknown>;
  if (v.questions !== undefined && !isStringList(v.questions)) return 'questions must be a list of strings.';
  const needsQuestions = v.decision === 'needs_info' || v.outcome === 'needs_info';
  if (needsQuestions && !(v.questions as string[] | undefined)?.length) return 'needs_info requires at least one question.';
  if (agent === 'classifier') {
    if (!['accept', 'reject', 'needs_info'].includes(v.decision as string)) return 'decision must be accept, reject or needs_info.';
    if (typeof v.reason !== 'string') return 'reason is required.';
    if (v.decision === 'accept' && !SIZES.includes(v.size as Size)) return 'size (xs–xl) is required to accept a ticket.';
    return v as unknown as ClassifierResult;
  }
  if (!['done', 'needs_info', 'failed'].includes(v.outcome as string)) return 'outcome must be done, needs_info or failed.';
  if (typeof v.summary !== 'string') return 'summary is required.';
  return v as unknown as WorkResult;
}
