import type { AgentName, ReworkOn, Size } from '../api-types.ts';
import { joinRefs } from '../scheduler/gates.ts';
import { addNeeds, applyEdits, label, labelDiff, moveTo, parseLabels, setSize, stageAfterClassify, stageAfterDesign, STAGE_OF_AGENT, type TicketState } from './labels.ts';
import type { AgentResult, ClassifierResult, Finding, Noticed, Part, Rescue, ReviewResult, Rework, WorkResult } from './schemas.ts';

/** Everything Workshop should do after a successful agent run. Pure, so every transition is unit-tested. */
export interface Plan {
  add: string[];
  remove: string[];
  comment?: string;
  /** Ticket numbers to link as blocking this ticket. */
  addBlockers?: number[];
  /** Prerequisite tickets to open (or find by title) and link as blocking this ticket. */
  raiseBlockers?: Noticed[];
  /** The agent that asked for `raiseBlockers`: in a reconcile, the one whose rescued work this is, not the Merge agent. */
  raisedBy?: AgentName;
  /** Open these smaller tickets in this one's place. Workshop lists them under `comment`. */
  split?: Part[];
  createBranch?: boolean;
  /** Push the agent's commits. */
  publish?: boolean;
  /** Open (or update) the pull request and request review. */
  openPr?: boolean;
  /** Try to merge the pull request, or push the work to the default branch. */
  merge?: boolean;
  /** The work lands without a pull request: forget the Implementation result kept for one. */
  noPr?: boolean;
  /** Store the Classifier's `ui` flag on the ticket. */
  ui?: boolean;
  /** Delete the ticket's media store: the ticket won't be worked on. */
  deleteMedia?: boolean;
  /** Delete this branch from the repository (a rescue branch that has been merged). */
  deleteBranch?: string;
  /** Forget the ticket's stored rescue. */
  clearRescue?: boolean;
  /** The agent gave up; counts toward the retry limit. */
  failure?: string;
  /** Store the Implementation result on the ticket, for the pull request the Code reviewer's run opens. */
  handOff?: boolean;
  /** Write the ticket's rework state; null clears it. */
  rework?: Rework | null;
  /** Markdown for the pull request body or update comment: the code review's findings. */
  reviewNotes?: string;
  /** Put `reviewNotes` first: problems the rework should have fixed remain. */
  flagged?: boolean;
  /** Write the code review findings to open as tickets once the work is pushed to the default branch; null clears them. */
  followUps?: Finding[] | null;
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
  /** The ticket's stored rescue, for the Merge agent in the reconcile stage. */
  rescue?: Rescue;
  /** Automatic reworks this review round, and the findings being fixed. */
  rework: Rework | null;
  /** The run id of the ticket's current handoff, if it has one. */
  handoffRunId?: string;
  /** The repository merges pull requests without waiting for an approval. */
  mergeWithoutReview: boolean;
  /** The repository takes reviewed work straight on its default branch, with no pull request. Undefined is off. */
  pushToDefault?: boolean;
  /** The ticket already has a pull request (opened before the setting was turned on): it keeps using it. */
  hasPr?: boolean;
  /** The lowest code review severity that sends the ticket back. Undefined is severe. */
  reworkOn?: ReworkOn;
  /** The repository lets Workshop open tickets for what agents find. Undefined is off. */
  raiseTickets?: boolean;
}

const NEXT_TEXT = { implement: 'implementation', design: 'design', 'design-review': 'design review' } as const;

/** Backstop on automatic send-backs per review round, in case every review finds a new problem. */
export const MAX_REWORKS = 3;
/** At most this many findings go into a comment or pull request: GitHub rejects bodies over 65,536 characters. */
export const MAX_FINDINGS_SHOWN = 30;
/** Findings stop once the list reaches this many characters, well under GitHub's limit with the rest of the body. */
const MAX_FINDINGS_CHARS = 40_000;
const MAX_FINDING_TEXT = 1000;
const MAX_TITLE = 200;
const MAX_SUMMARY = 4000;

const SEVERITY_ORDER: Finding['severity'][] = ['severe', 'moderate', 'minor'];

/** Whether a finding is at or above the repository's rework threshold. */
export const qualifies = (f: Finding, on: ReworkOn) => SEVERITY_ORDER.indexOf(f.severity) <= SEVERITY_ORDER.indexOf(on);

/** A severe or moderate finding that doesn't say what goes wrong counts as minor, so it can't send a ticket back or raise one. */
export const effectiveFindings = (findings: Finding[]): Finding[] =>
  findings.map((f) => (f.severity !== 'minor' && !f.consequence?.trim() ? { ...f, severity: 'minor' } : f));

/** Where qualifying findings send a ticket: design when the design is at fault and the ticket has one, else implementation. */
export function stageForRework(size: Size | null, findings: Finding[], on: ReworkOn = 'severe'): 'design' | 'implement' | null {
  const qualifying = findings.filter((f) => qualifies(f, on));
  if (!qualifying.length) return null;
  const designed = size === 'm' || size === 'l' || size === 'xl';
  return designed && qualifying.some((f) => f.cause === 'design') ? 'design' : 'implement';
}
const SEVERITY_TEXT = { severe: 'Severe', moderate: 'Moderate', minor: 'Minor' } as const;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const clip = (text: string, max = MAX_FINDING_TEXT) => cut(text.replace(/\s+/g, ' ').trim(), max);

export function formatFinding(f: Finding): string {
  const where = f.file ? ` (\`${clip(f.file.replace(/`/g, ''), MAX_TITLE)}${f.line ? `:${f.line}` : ''}\`)` : '';
  return `- **${SEVERITY_TEXT[f.severity]}**${where} ${clip(f.title, MAX_TITLE)}: ${clip(f.detail)}\n  Checked: ${clip(f.evidence)}\n  Fix: ${clip(f.fix)}`;
}

/** The findings as a Markdown list, most severe first, capped at MAX_FINDINGS_SHOWN and MAX_FINDINGS_CHARS. */
export function formatFindings(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const lines: string[] = [];
  let size = 0;
  for (const f of sorted.slice(0, MAX_FINDINGS_SHOWN)) {
    const text = formatFinding(f);
    if (size + text.length > MAX_FINDINGS_CHARS) break;
    lines.push(text);
    size += text.length + 1;
  }
  const left = sorted.length - lines.length;
  if (left > 0) lines.push(`\n_${left} more finding${left === 1 ? '' : 's'} left out; see the Code reviewer's run._`);
  return lines.join('\n');
}

export const exhaustedText = (on: ReworkOn = 'severe') =>
  `**The code review still found ${on === 'severe' ? 'severe ' : ''}problems after Workshop's rework. Read them before approving.**`;

/** The Code review section of a pull request. */
export function reviewSection(r: ReviewResult, exhausted: boolean, on: ReworkOn = 'severe'): string {
  const findings = r.findings ?? [];
  return [
    '### Code review',
    exhausted ? exhaustedText(on) : '',
    cut(r.summary.trim(), MAX_SUMMARY),
    findings.length ? formatFindings(findings) : 'No problems found.',
    r.tests ? `**Reviewer ran:** ${r.tests}` : '',
  ].filter(Boolean).join('\n\n');
}

const problems = (n: number, on: ReworkOn) => `${n} ${on === 'severe' ? 'severe ' : ''}problem${n === 1 ? '' : 's'}`;

/** The body of a follow-up ticket for a finding left on the default branch. */
export function followUpBody(f: Finding, ticket: { number: number }, commit: { sha: string; url: string }, base: string): string {
  const where = f.file ? `**Where:** \`${f.file.replace(/`/g, '')}${f.line ? `:${f.line}` : ''}\`` : '';
  return [
    f.detail.trim(),
    [f.consequence?.trim() ? `**What goes wrong:** ${f.consequence.trim()}` : '', where, `**Checked:** ${f.evidence.trim()}`, `**Fix:** ${f.fix.trim()}`].filter(Boolean).join('\n'),
    `---\n_Workshop's Code reviewer found this in the work for #${ticket.number}, which was pushed to \`${base}\` as [\`${commit.sha.slice(0, 7)}\`](${commit.url}) without fixing it._`,
  ].join('\n\n');
}

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
  // Keep partial work on the branch so you can see it while answering. The Code reviewer has nothing to keep.
  if (r.outcome === 'needs_info') return { add: [label.needsInfo], remove: [], publish: ctx.agent !== 'code-review', comment: questionsComment(ctx, r.questions) };
  // Partial work is kept, as with needs_info; the stage runs again once the prerequisites close.
  if (r.outcome === 'blocked') return { ...planWait(ctx.agent, r.blocked_by ?? [], r.raise_blockers ?? [], r.summary), publish: true };

  const doc = `[\`${ctx.docPath}\`](${ctx.docUrl})`;
  switch (ctx.agent) {
    case 'design': {
      const next = stageAfterDesign(ctx.state.size);
      return { ...moveTo(ctx.labels, next), publish: true, comment: `Design written: ${doc}\n\n${r.summary}\n\nNext: ${NEXT_TEXT[next]}.` };
    }
    case 'design-review':
      return { ...moveTo(ctx.labels, 'implement'), publish: true, comment: `Design reviewed and revised: ${doc}\n\n${r.summary}\n\nNext: implementation.` };
    case 'implement':
      return { ...moveTo(ctx.labels, 'code-review'), publish: true, handOff: true, comment: 'Implementation finished and pushed. Next: code review.' };
    case 'code-review':
      return planReview(ctx, r as ReviewResult);
    case 'merge':
      if (ctx.state.stage === 'reconcile') return planReconcile(ctx, r);
      return { add: [], remove: [], publish: true, merge: true };
  }
}

/**
 * Findings at or above the repository's threshold go back to design or implementation until a rework fails to fix
 * one (or MAX_REWORKS); everything else goes into the pull request, or, when pushing to the default branch, into
 * the comment, with the qualifying ones kept to open as follow-up tickets.
 */
function planReview(ctx: PlanContext, r: ReviewResult): Plan {
  const on = ctx.reworkOn ?? 'severe';
  const findings = effectiveFindings(r.findings ?? []);
  const review = { ...r, findings };
  const target = stageForRework(ctx.state.size, findings, on);
  // A send-back whose publish failed (say, GitHub errored after the rework was stored) left no new handoff: don't count it.
  const pending = ctx.rework?.handoffRunId !== undefined && ctx.rework.handoffRunId === ctx.handoffRunId;
  const count = (ctx.rework?.count ?? 0) - (pending ? 1 : 0);
  const qualifying = findings.filter((f) => qualifies(f, on));
  // A new problem gets another rework; one the last rework didn't fix needs you.
  const unfixed = count > 0 && qualifying.some((f) => f.repeat);
  if (target && !unfixed && count < MAX_REWORKS) {
    const where = NEXT_TEXT[target];
    return {
      ...moveTo(ctx.labels, target),
      rework: { count: count + 1, findings: qualifying, handoffRunId: ctx.handoffRunId },
      followUps: null,
      comment: [
        `Code review found ${problems(qualifying.length, on)}, so Workshop sends this ticket back to ${where} (rework ${count + 1} of ${MAX_REWORKS}):`,
        formatFindings(qualifying),
        cut(r.summary.trim(), MAX_SUMMARY),
        `Next: ${where}.`,
      ].filter(Boolean).join('\n\n'),
    };
  }
  const exhausted = target !== null;
  if (ctx.pushToDefault && !ctx.hasPr) {
    const move = moveTo(ctx.labels, 'merge');
    // Nothing else stops a push, so severe problems that remain wait for you. Anything less is pushed and followed up.
    const hold = exhausted && findings.some((f) => f.severity === 'severe');
    const notes = reviewSection(review, hold, on);
    const followUps = qualifying.length ? qualifying : null;
    const raising = followUps !== null && ctx.raiseTickets === true && !ctx.labels.includes(label.raised);
    const promise = raising ? '\n\nWorkshop opens a follow-up ticket for each problem at or above the rework threshold once this is pushed.' : '';
    if (!hold) return { ...move, rework: null, noPr: true, merge: true, followUps, comment: `${notes}${promise}\n\nNext: Workshop pushes this to the default branch.` };
    return {
      ...move,
      add: [...move.add, label.needsInfo],
      rework: null,
      noPr: true,
      followUps,
      comment: `@${ctx.author} The code review still found severe problems after Workshop's rework, so it won't push this to the default branch without you.\n\n${notes}${promise}\n\nRemove the \`${label.needsInfo}\` label to push it as it is, or say what to change in a comment and move the ticket back to implementation.`,
    };
  }
  const hold = exhausted && ctx.mergeWithoutReview;
  const move = moveTo(ctx.labels, 'pr-review');
  return {
    ...move,
    add: hold ? [...move.add, label.needsInfo] : move.add,
    openPr: true,
    rework: null,
    followUps: null,
    reviewNotes: reviewSection(review, exhausted, on),
    ...(exhausted ? { flagged: true } : {}),
    ...(hold
      ? {
          comment: `@${ctx.author} The code review still found ${on === 'severe' ? 'severe ' : ''}problems after Workshop's rework, so it won't merge this pull request without you. Read the Code review section on the pull request, then request changes, or remove the \`${label.needsInfo}\` label to let it merge.`,
        }
      : {}),
  };
}

/** The Merge agent merged the saved work: finish the stage that the rescued push interrupted. */
function planReconcile(ctx: PlanContext, r: WorkResult): Plan {
  const rescue = ctx.rescue;
  if (!rescue) return { add: [], remove: [], failure: 'Nothing to reconcile: Workshop has no saved work for this ticket. Move it to another stage.' };
  const asBefore = applyEdits(ctx.labels, moveTo(ctx.labels, STAGE_OF_AGENT[rescue.agent]!));
  const inner = planTransition({ ...ctx, agent: rescue.agent, mode: rescue.mode, labels: asBefore, state: parseLabels(asBefore), rescue: undefined }, rescue.result);
  const merged = `The Merge agent merged the saved work from \`${rescue.branch}\` into this branch:\n\n${r.summary}`;
  return {
    ...inner,
    ...labelDiff(ctx.labels, applyEdits(asBefore, inner)),
    publish: true,
    deleteBranch: rescue.branch,
    clearRescue: true,
    comment: [merged, inner.comment].filter(Boolean).join('\n\n'),
  };
}

/** Park the ticket on existing tickets (`numbers`) and new prerequisite tickets (`raise`), with no label change. */
function planWait(agent: AgentName, numbers: number[], raise: Noticed[], reason: string): Plan {
  const refs = joinRefs(numbers.map((n) => `#${n}`));
  const what = raise.length ? `${numbers.length ? `${refs} and ` : ''}the prerequisite tickets listed below` : refs;
  return {
    add: [],
    remove: [],
    ...(numbers.length ? { addBlockers: numbers } : {}),
    ...(raise.length ? { raiseBlockers: raise, raisedBy: agent } : {}),
    comment: `Workshop will wait for ${what} before working on this ticket: ${reason}\n\nIt carries on once they're closed. If it shouldn't wait, remove the link under Relationships and say so in a comment.`,
  };
}

function planClassifier(ctx: PlanContext, r: ClassifierResult): Plan {
  if (r.decision === 'needs_info') return { add: [label.needsInfo], remove: [], comment: questionsComment(ctx, r.questions) };
  if (r.decision === 'blocked') return planWait(ctx.agent, r.blocked_by ?? [], r.raise_blockers ?? [], r.reason);
  if (r.decision === 'split') {
    return {
      add: [label.skip, label.split],
      remove: [...moveTo(ctx.labels, null).remove, ...ctx.labels.filter((l) => l === label.tooBig)],
      split: r.parts,
      comment: `Workshop broke this ticket into smaller ones: ${r.reason}`,
    };
  }
  if (r.decision === 'reject') {
    return {
      add: [label.skip],
      deleteMedia: true,
      remove: moveTo(ctx.labels, null).remove,
      comment: `Workshop won't work on this ticket: ${r.reason}\n\nRemove the \`${label.skip}\` label to have it classified again.`,
    };
  }
  const size = r.size!;
  const next = stageAfterClassify(size);
  const what = ctx.mode === 'delta' ? 'the requested changes' : 'this ticket';
  return {
    ...combine(setSize(ctx.labels, size), moveTo(ctx.labels, next), addNeeds(ctx.labels, r.capabilities ?? []), { add: [], remove: ctx.labels.filter((l) => l === label.tooBig) }),
    createBranch: ctx.mode === 'normal',
    // A new classification starts a new review round.
    rework: null,
    ...(r.ui !== undefined ? { ui: r.ui === true } : {}),
    comment: `Workshop sized ${what} **${size.toUpperCase()}**: ${r.reason}${r.one_change?.trim() ? `\n\nKept as one ticket: ${r.one_change.trim()}` : ''}\n\n${r.capabilities?.includes('browser') ? '\n\nImplementation will run with a browser (Playwright) to test it.' : ''}\n\nNext: ${NEXT_TEXT[next]}.`,
  };
}
