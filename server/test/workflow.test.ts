import { describe, expect, it } from 'vitest';
import { branchFor, label, nextStep, parseLabels, stageAfterClassify } from '../src/workflow/labels.ts';
import { parseResult } from '../src/workflow/schemas.ts';
import { planTransition, type PlanContext } from '../src/workflow/transitions.ts';
import { taskPrompt } from '../src/workflow/prompts.ts';

const step = (labels: string[], open = true) => nextStep(parseLabels(labels), open);

describe('nextStep (the ticket state machine)', () => {
  it('classifies tickets without workshop labels', () => {
    expect(step([])).toEqual({ kind: 'agent', agent: 'classifier', mode: 'normal' });
    expect(step(['bug'])).toEqual({ kind: 'agent', agent: 'classifier', mode: 'normal' });
  });

  it('follows the stage label', () => {
    expect(step([label.stage('design')])).toMatchObject({ agent: 'design' });
    expect(step([label.stage('design-review')])).toMatchObject({ agent: 'design-review' });
    expect(step([label.stage('implement')])).toMatchObject({ agent: 'implement' });
    expect(step([label.stage('reclassify')])).toEqual({ kind: 'agent', agent: 'classifier', mode: 'delta' });
    expect(step([label.stage('merge')])).toEqual({ kind: 'merge' });
  });

  it('waits on you for review, questions, skips, failures and closed tickets', () => {
    expect(step([label.stage('pr-review')])).toBeNull();
    expect(step([label.stage('design'), label.needsInfo])).toBeNull();
    expect(step([label.skip])).toBeNull();
    expect(step([label.stage('implement'), label.failed])).toBeNull();
    expect(step([label.stage('implement')], false)).toBeNull();
  });

  it('resumes the same stage once needs-info is removed', () => {
    const labels = [label.size('l'), label.stage('design-review'), label.needsInfo];
    expect(step(labels)).toBeNull();
    expect(step(labels.filter((l) => l !== label.needsInfo))).toMatchObject({ agent: 'design-review' });
  });

  it('routes sizes as the diagram does', () => {
    expect(stageAfterClassify('xs')).toBe('implement');
    expect(stageAfterClassify('s')).toBe('implement');
    expect(stageAfterClassify('m')).toBe('design');
    expect(stageAfterClassify('xl')).toBe('design');
  });

  it('names branches from the issue title', () => {
    expect(branchFor(42, 'Add dark mode!! (settings page)')).toBe('workshop/42-add-dark-mode-settings-page');
    expect(branchFor(7, '???')).toBe('workshop/7-ticket');
  });
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext => {
  const labels = over.labels ?? [];
  return {
    agent: 'classifier',
    mode: 'normal',
    labels,
    state: parseLabels(labels),
    author: 'damiante',
    docPath: 'docs/workshop/1-x.md',
    docUrl: 'https://example/doc',
    ...over,
  };
};

describe('planTransition', () => {
  it('classify accept: sets size, stage and creates the branch', () => {
    const plan = planTransition(ctx(), { decision: 'accept', size: 's', reason: 'Small.' });
    expect(plan.add).toEqual([label.size('s'), label.stage('implement')]);
    expect(plan.createBranch).toBe(true);
    expect(plan.comment).toContain('**S**');
  });

  it('re-classify replaces the size and stage but keeps the branch', () => {
    const labels = [label.size('xl'), label.stage('reclassify')];
    const plan = planTransition(ctx({ labels, mode: 'delta' }), { decision: 'accept', size: 'm', reason: 'Moderate.' });
    expect(plan.add).toEqual([label.size('m'), label.stage('design')]);
    expect(plan.remove).toEqual([label.size('xl'), label.stage('reclassify')]);
    expect(plan.createBranch).toBe(false);
  });

  it.each(['normal', 'delta'] as const)('classify blocked (%s): links the blockers and changes no labels or branch', (mode) => {
    const labels = mode === 'delta' ? [label.size('s'), label.stage('reclassify')] : [];
    const plan = planTransition(ctx({ labels, mode }), { decision: 'blocked', blocked_by: [2], reason: 'Needs the API.' });
    expect(plan).toMatchObject({ add: [], remove: [], addBlockers: [2] });
    expect(plan.createBranch).toBeUndefined();
    expect(plan.comment).toContain('wait for #2');
    expect(plan.comment).toContain('Needs the API.');
  });

  it('classify reject: skip label and reason comment', () => {
    const plan = planTransition(ctx(), { decision: 'reject', reason: 'This is a question.' });
    expect(plan.add).toEqual([label.skip]);
    expect(plan.comment).toContain('This is a question.');
  });

  it('needs_info: label plus @mention with numbered questions, stage untouched', () => {
    const labels = [label.size('m'), label.stage('design')];
    const plan = planTransition(ctx({ agent: 'design', labels }), { outcome: 'needs_info', summary: '', questions: ['A or B?', 'Which DB?'] });
    expect(plan.add).toEqual([label.needsInfo]);
    expect(plan.remove).toEqual([]);
    expect(plan.comment).toMatch(/@damiante[\s\S]*1\. A or B\?\n2\. Which DB\?/);
    expect(plan.publish).toBe(true);
  });

  it('design goes to implement for M and to design review for L/XL', () => {
    const m = [label.size('m'), label.stage('design')];
    expect(planTransition(ctx({ agent: 'design', labels: m }), { outcome: 'done', summary: 'ok' }).add).toEqual([label.stage('implement')]);
    const l = [label.size('l'), label.stage('design')];
    expect(planTransition(ctx({ agent: 'design', labels: l }), { outcome: 'done', summary: 'ok' }).add).toEqual([label.stage('design-review')]);
  });

  it('design review goes to implement', () => {
    const labels = [label.size('xl'), label.stage('design-review')];
    const plan = planTransition(ctx({ agent: 'design-review', labels }), { outcome: 'done', summary: 'ok' });
    expect(plan).toMatchObject({ add: [label.stage('implement')], remove: [label.stage('design-review')], publish: true });
  });

  it('implement pushes, opens the PR and waits for review', () => {
    const labels = [label.size('s'), label.stage('implement')];
    const plan = planTransition(ctx({ agent: 'implement', labels }), { outcome: 'done', summary: 'ok' });
    expect(plan).toMatchObject({ add: [label.stage('pr-review')], publish: true, openPr: true });
  });

  it('merge agent pushes then merges', () => {
    const plan = planTransition(ctx({ agent: 'merge', labels: [label.stage('merge')] }), { outcome: 'done', summary: 'ok' });
    expect(plan).toMatchObject({ publish: true, merge: true });
  });

  it('a failed outcome is a failure, nothing published', () => {
    const plan = planTransition(ctx({ agent: 'implement' }), { outcome: 'failed', summary: 'Tests never pass.' });
    expect(plan.failure).toBe('Tests never pass.');
    expect(plan.publish).toBeUndefined();
  });
});

describe('parseResult', () => {
  it('requires a size to accept and questions for needs_info', () => {
    expect(parseResult('classifier', { decision: 'accept', reason: 'x' })).toMatch(/size/);
    expect(parseResult('design', { outcome: 'needs_info', summary: '' })).toMatch(/question/);
    expect(parseResult('design', null)).toMatch(/no structured result/);
    expect(parseResult('classifier', { decision: 'accept', size: 'm', reason: 'x' })).toEqual({ decision: 'accept', size: 'm', reason: 'x' });
  });
});

describe('parseResult blocked', () => {
  it('requires a list of positive ticket numbers', () => {
    expect(parseResult('classifier', { decision: 'blocked', blocked_by: [2], reason: 'x' })).toMatchObject({ decision: 'blocked', blocked_by: [2] });
    for (const blocked_by of [undefined, [], ['2'], [0], [1.5]]) {
      expect(parseResult('classifier', { decision: 'blocked', blocked_by, reason: 'x' })).toMatch(/blocked requires blocked_by/);
    }
  });
});

describe('taskPrompt', () => {
  const base = {
    mode: 'normal' as const,
    repo: 'me/app',
    base: 'main',
    branch: 'workshop/3-x',
    docPath: 'd.md',
    ticket: { number: 3, title: 'X', body: 'Do X', url: 'u', labels: [], size: null },
    comments: [],
    omittedComments: 0,
    review: [],
  };

  it('lists the other open tickets for the classifier only, trimmed and counted', () => {
    const openTickets = Array.from({ length: 32 }, (_, i) => ({ number: i + 10, title: `T${i}`, body: i === 0 ? 'y'.repeat(700) : 'short' }));
    const prompt = taskPrompt({ ...base, agent: 'classifier', openTickets });
    expect(prompt).toContain('## Other open tickets in this repository');
    expect(prompt).toContain('### #10: T0');
    expect(prompt).toContain(`${'y'.repeat(600)}…`);
    expect(prompt).not.toContain('y'.repeat(601));
    expect(prompt).toContain('### #39: T29');
    expect(prompt).not.toContain('### #40:');
    expect(prompt).toContain('_2 more open ticket(s) left out._');
    expect(prompt).toContain('return "blocked"');
    expect(taskPrompt({ ...base, agent: 'design', openTickets })).not.toContain('Other open tickets');
    expect(taskPrompt({ ...base, agent: 'classifier' })).not.toContain('Other open tickets');
  });

  it('includes the ticket, comments, omissions, review feedback and the task', () => {
    const prompt = taskPrompt({
      agent: 'implement',
      mode: 'normal',
      repo: 'me/app',
      base: 'main',
      branch: 'workshop/3-x',
      docPath: 'docs/workshop/3-x.md',
      ticket: { number: 3, title: 'X', body: 'Do X', url: 'u', labels: ['workshop/size:s'], size: 's' },
      comments: [{ author: 'me', body: 'Use Y', createdAt: '2026-10-01T00:00:00Z' }],
      omittedComments: 2,
      review: [{ author: 'me', body: 'Rename this', path: 'a.ts', line: 4 }],
    });
    expect(prompt).toContain('# me/app#3: X');
    expect(prompt).toContain('**@me** (2026-10-01):');
    expect(prompt).toContain('2 comment(s) from people outside');
    expect(prompt).toContain('on `a.ts:4`: Rename this');
    expect(prompt).toContain('Address all of the review feedback above.');
  });
});
