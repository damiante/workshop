import type { AgentName } from '../api-types.ts';
import { joinRefs } from '../scheduler/gates.ts';
import { label, moveTo, setSize, stageAfterClassify, stageAfterDesign, type TicketState } from './labels.ts';
import type { AgentResult, ClassifierResult, WorkResult } from './schemas.ts';

/** Everything Workshop should do after a successful agent run. Pure, so every transition is unit-tested. */
export interface Plan {
  add: string[];
  remove: string[];
  comment?: string;
  /** Ticket numbers to link as blocking this ticket. */
  addBlockers?: number[];
  createBranch?: boolean;
  /** Push the agent's commits. */
  publish?: boolean;
  /** Open (or update) the pull request and request review. */
  openPr?: boolean;
  /** Try to merge the pull request. */
  merge?: boolean;
  /** The agent gave up; counts toward the retry limit. */
  failure?: string;
}

export interface PlanContext {
  agent: AgentName;
  mode: 'normal' | 'delta';
  labels: string[];
  state: TicketState;
  /** Who to @mention with questions (the ticket's author). */
  author: string;
  docPath: string;
  docUrl: string;
}

const NEXT_TEXT = { implement: 'implementation', design: 'design', 'design-review': 'design review' } as const;

function questionsComment(ctx: PlanContext, questions: string[] = []) {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return `@${ctx.author} Workshop needs your input to continue:\n\n${list}\n\nReply in a comment, then remove the \`${label.needsInfo}\` label and Workshop will carry on from here.`;
}

function combine(...edits: { add: string[]; remove: string[] }[]) {
  return { add: edits.flatMap((e) => e.add), remove: edits.flatMap((e) => e.remove) };
}

export function planTransition(ctx: PlanContext, result: AgentResult): Plan {
  if (ctx.agent === 'classifier') return planClassifier(ctx, result as ClassifierResult);
  const r = result as WorkResult;
  if (r.outcome === 'failed') return { add: [], remove: [], failure: r.summary };
  // Keep partial work on the branch so you can see it while answering.
  if (r.outcome === 'needs_info') return { add: [label.needsInfo], remove: [], publish: true, comment: questionsComment(ctx, r.questions) };

  const doc = `[\`${ctx.docPath}\`](${ctx.docUrl})`;
  switch (ctx.agent) {
    case 'design': {
      const next = stageAfterDesign(ctx.state.size);
      return { ...moveTo(ctx.labels, next), publish: true, comment: `Design written: ${doc}\n\n${r.summary}\n\nNext: ${NEXT_TEXT[next]}.` };
    }
    case 'design-review':
      return { ...moveTo(ctx.labels, 'implement'), publish: true, comment: `Design reviewed and revised: ${doc}\n\n${r.summary}\n\nNext: implementation.` };
    case 'implement':
      return { ...moveTo(ctx.labels, 'pr-review'), publish: true, openPr: true };
    case 'merge':
      return { add: [], remove: [], publish: true, merge: true };
  }
}

function planClassifier(ctx: PlanContext, r: ClassifierResult): Plan {
  if (r.decision === 'needs_info') return { add: [label.needsInfo], remove: [], comment: questionsComment(ctx, r.questions) };
  if (r.decision === 'blocked') {
    const refs = joinRefs(r.blocked_by!.map((n) => `#${n}`));
    return {
      add: [],
      remove: [],
      addBlockers: r.blocked_by,
      comment: `Workshop will wait for ${refs} before working on this ticket: ${r.reason}\n\nIt carries on once they're closed. If it shouldn't wait, remove the link under Relationships and say so in a comment.`,
    };
  }
  if (r.decision === 'reject') {
    return {
      add: [label.skip],
      remove: moveTo(ctx.labels, null).remove,
      comment: `Workshop won't work on this ticket: ${r.reason}\n\nRemove the \`${label.skip}\` label to have it classified again.`,
    };
  }
  const size = r.size!;
  const next = stageAfterClassify(size);
  const what = ctx.mode === 'delta' ? 'the requested changes' : 'this ticket';
  return {
    ...combine(setSize(ctx.labels, size), moveTo(ctx.labels, next)),
    createBranch: ctx.mode === 'normal',
    comment: `Workshop sized ${what} **${size.toUpperCase()}**: ${r.reason}\n\nNext: ${NEXT_TEXT[next]}.`,
  };
}
