import type { AgentName, Size, Stage } from '../api-types.ts';
import type { LabelDef } from '../providers/types.ts';

export const SIZES: Size[] = ['xs', 's', 'm', 'l', 'xl'];
export const STAGES: Stage[] = ['design', 'design-review', 'implement', 'pr-review', 'merge', 'reclassify'];

export const label = {
  size: (size: Size) => `workshop/size:${size}`,
  stage: (stage: Stage) => `workshop/stage:${stage}`,
  needsInfo: 'workshop/needs-info',
  skip: 'workshop/skip',
  failed: 'workshop/failed',
  running: 'workshop/running',
  nominated: 'workshop/nominated',
};

const STAGE_TEXT: Record<Stage, string> = {
  design: 'design next',
  'design-review': 'design review next',
  implement: 'implementation next',
  'pr-review': 'pull request waiting for your review',
  merge: 'approved, merge next',
  reclassify: 'changes requested, re-classify next',
};

export const LABEL_DEFS: LabelDef[] = [
  ...SIZES.map((size) => ({ name: label.size(size), color: '8d7b68', description: `Workshop: size ${size.toUpperCase()}` })),
  ...STAGES.map((stage) => ({ name: label.stage(stage), color: '5c6b73', description: `Workshop: ${STAGE_TEXT[stage]}` })),
  { name: label.needsInfo, color: 'b38b42', description: 'Workshop: question for you. Reply, then remove this label' },
  { name: label.skip, color: '9e9e9e', description: 'Workshop: not suitable. Remove to classify again' },
  { name: label.failed, color: 'a0503f', description: 'Workshop: stopped. Remove to retry' },
  { name: label.running, color: '7f8c5c', description: 'Workshop: an agent is working on this' },
  { name: label.nominated, color: '7a6a53', description: 'Workshop: work on this ticket when its repository only takes nominated tickets' },
];

export interface TicketState {
  size: Size | null;
  stage: Stage | null;
  needsInfo: boolean;
  skip: boolean;
  failed: boolean;
}

export function parseLabels(labels: string[]): TicketState {
  const size = SIZES.find((s) => labels.includes(label.size(s))) ?? null;
  const stage = STAGES.find((s) => labels.includes(label.stage(s))) ?? null;
  return {
    size,
    stage,
    needsInfo: labels.includes(label.needsInfo),
    skip: labels.includes(label.skip),
    failed: labels.includes(label.failed),
  };
}

export type Step = { kind: 'agent'; agent: AgentName; mode: 'normal' | 'delta' } | { kind: 'merge' };

/** The state machine: what Workshop does next for a ticket, or null while it waits on you (or is done). */
export function nextStep(state: TicketState, open: boolean): Step | null {
  if (!open || state.needsInfo || state.skip || state.failed) return null;
  switch (state.stage) {
    case null:
      return { kind: 'agent', agent: 'classifier', mode: 'normal' };
    case 'reclassify':
      return { kind: 'agent', agent: 'classifier', mode: 'delta' };
    case 'design':
    case 'design-review':
    case 'implement':
      return { kind: 'agent', agent: state.stage, mode: 'normal' };
    case 'merge':
      return { kind: 'merge' };
    case 'pr-review':
      return null;
  }
}

const AGENT_TEXT: Record<AgentName, string> = {
  classifier: 'Classify',
  design: 'Design',
  'design-review': 'Design review',
  implement: 'Implement',
  merge: 'Resolve merge conflicts',
};

export function describeStep(step: Step | null): string | null {
  if (!step) return null;
  if (step.kind === 'merge') return 'Merge';
  return step.mode === 'delta' ? 'Re-classify requested changes' : AGENT_TEXT[step.agent];
}

/** XS/S skip design; M gets a design; L/XL also get a design review. */
export function stageAfterClassify(size: Size): 'implement' | 'design' {
  return size === 'xs' || size === 's' ? 'implement' : 'design';
}

export function stageAfterDesign(size: Size | null): 'implement' | 'design-review' {
  return size === 'l' || size === 'xl' ? 'design-review' : 'implement';
}

/** Label edits that move a ticket to `stage` (or clear the stage), leaving one stage label at most. */
export function moveTo(labels: string[], stage: Stage | null) {
  const target = stage ? label.stage(stage) : null;
  return {
    add: target && !labels.includes(target) ? [target] : [],
    remove: STAGES.map(label.stage).filter((name) => name !== target && labels.includes(name)),
  };
}

export function setSize(labels: string[], size: Size) {
  const target = label.size(size);
  return {
    add: labels.includes(target) ? [] : [target],
    remove: SIZES.map(label.size).filter((name) => name !== target && labels.includes(name)),
  };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'ticket';
}

export const branchFor = (number: number, title: string) => `workshop/${number}-${slugify(title)}`;
export const designDocFor = (number: number, title: string) => `docs/workshop/${number}-${slugify(title)}.md`;
