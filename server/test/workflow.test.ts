import { describe, expect, it } from 'vitest';
import { addNeeds, branchFor, imageFor, label, nextStep, parseLabels, stageAfterClassify, stateEdits } from '../src/workflow/labels.ts';
import { parseResult } from '../src/workflow/schemas.ts';
import { planTransition, type PlanContext } from '../src/workflow/transitions.ts';
import { capabilitiesOf, environmentText, taskPrompt } from '../src/workflow/prompts.ts';

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

  it('classify accept with a browser capability adds the needs label and says so', () => {
    const plan = planTransition(ctx(), { decision: 'accept', size: 's', reason: 'UI.', capabilities: ['browser'] });
    expect(plan.add).toContain(label.needs('browser'));
    expect(plan.comment).toContain('run with a browser');
    expect(planTransition(ctx(), { decision: 'accept', size: 's', reason: 'x', capabilities: [] }).comment).not.toContain('browser');
  });

  it('re-classify never removes a needs label the owner added', () => {
    const labels = [label.size('s'), label.stage('reclassify'), label.needs('browser')];
    const plan = planTransition(ctx({ labels, mode: 'delta' }), { decision: 'accept', size: 's', reason: 'x', capabilities: [] });
    expect(plan.remove).not.toContain(label.needs('browser'));
    expect(plan.add).not.toContain(label.needs('browser'));
  });

  it('a failed outcome is a failure, nothing published', () => {
    const plan = planTransition(ctx({ agent: 'implement' }), { outcome: 'failed', summary: 'Tests never pass.' });
    expect(plan.failure).toBe('Tests never pass.');
    expect(plan.publish).toBeUndefined();
  });
});

describe('parseResult', () => {
  it('validates the classifier capabilities', () => {
    const accept = { decision: 'accept', size: 's', reason: 'x' };
    expect(parseResult('classifier', { ...accept, capabilities: ['browser'] })).toMatchObject({ capabilities: ['browser'] });
    expect(parseResult('classifier', accept)).toEqual(accept);
    expect(parseResult('classifier', { ...accept, capabilities: ['gpu'] })).toMatch(/capabilities must be a list of: browser/);
    expect(parseResult('classifier', { ...accept, capabilities: 'browser' })).toMatch(/capabilities must be a list/);
  });

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
    ui: false,
    media: [],
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
      ui: false,
      media: [],
    });
    expect(prompt).toContain('# me/app#3: X');
    expect(prompt).toContain('**@me** (2026-10-01):');
    expect(prompt).toContain('2 comment(s) from people outside');
    expect(prompt).toContain('on `a.ts:4`: Rename this');
    expect(prompt).toContain('Address all of the review feedback above.');
  });

  it('lists the media store with source and caption, or says it is empty', () => {
    expect(taskPrompt({ ...base, agent: 'implement' })).toContain('## Media\n\n(Empty.)');
    const prompt = taskPrompt({
      ...base,
      agent: 'implement',
      media: [
        { name: 'issue-1.png', source: 'issue', runId: null, caption: null },
        { name: 'comment-1.png', source: 'comment', runId: null, caption: null },
        { name: 'after.png', source: 'Implementation', runId: 'abcdef12-0000', caption: 'Dark mode' },
      ],
    });
    expect(prompt).toContain('- /work/media/issue-1.png: from the issue');
    expect(prompt).toContain('- /work/media/comment-1.png: from a comment');
    expect(prompt).toContain('- /work/media/after.png: added by Implementation (run abcdef12): Dark mode');
    expect(prompt).toContain('Read tool');
    expect(prompt).toContain('`media` field');
  });

  it('mentions a browser to Design and Design adversary only when ui is set; Implementation always gets the screenshot sentence', () => {
    for (const agent of ['design', 'design-review'] as const) {
      expect(taskPrompt({ ...base, agent })).not.toMatch(/browser|Playwright/);
      expect(taskPrompt({ ...base, agent, ui: true })).toContain('Playwright with Chromium');
    }
    for (const ui of [false, true]) expect(taskPrompt({ ...base, agent: 'implement', ui })).toContain('screenshot the changed screens');
    expect(taskPrompt({ ...base, agent: 'classifier' })).not.toMatch(/Playwright/);
  });
});

describe('media and ui results', () => {
  it('accepts and rejects ui on the classifier', () => {
    expect(parseResult('classifier', { decision: 'accept', size: 's', reason: 'r', ui: true })).toMatchObject({ ui: true });
    expect(parseResult('classifier', { decision: 'accept', size: 's', reason: 'r', ui: false })).toMatchObject({ ui: false });
    expect(parseResult('classifier', { decision: 'accept', size: 's', reason: 'r', ui: 'yes' })).toMatch(/ui must be/);
  });

  it('accepts and rejects media on work results', () => {
    expect(parseResult('implement', { outcome: 'done', summary: 's', media: [{ path: '/work/media/a.png', caption: 'A' }] })).toMatchObject({ media: [{ path: '/work/media/a.png' }] });
    expect(parseResult('implement', { outcome: 'done', summary: 's', media: [] })).toMatchObject({ outcome: 'done' });
    expect(parseResult('implement', { outcome: 'done', summary: 's', media: 'x' })).toBe('media must be a list of { path, caption }.');
    expect(parseResult('implement', { outcome: 'done', summary: 's', media: [{ path: 1 }] })).toBe('media must be a list of { path, caption }.');
    expect(parseResult('implement', { outcome: 'done', summary: 's', media: [{ path: 'a.png' }] })).toBe('media must be a list of { path, caption }.');
  });

  it('carries ui on accept and deletes the media store on reject', () => {
    const ctx = { agent: 'classifier', mode: 'normal', labels: [], state: parseLabels([]), author: 'me', docPath: 'd.md', docUrl: 'u' } as PlanContext;
    expect(planTransition(ctx, { decision: 'accept', size: 'm', reason: 'r', ui: true })).toMatchObject({ ui: true });
    expect(planTransition(ctx, { decision: 'accept', size: 'm', reason: 'r' }).ui).toBeUndefined();
    expect(planTransition(ctx, { decision: 'reject', reason: 'r' }).deleteMedia).toBe(true);
  });

  it('gives Design and Design adversary the browser image only with ui; a repository image still wins', () => {
    const images = { repo: null, base: 'base', browser: 'browser' };
    const plain = parseLabels([]);
    for (const agent of ['design', 'design-review'] as const) {
      expect(imageFor(agent, plain, images)).toBe('base');
      expect(imageFor(agent, plain, images, true)).toBe('browser');
      expect(imageFor(agent, plain, { ...images, repo: 'mine' }, true)).toBe('mine');
    }
    expect(imageFor('classifier', plain, images, true)).toBe('base');
  });
});

describe('stateEdits', () => {
  const labels = ['bug', 'workshop/stage:design', 'workshop/size:m', 'workshop/running'];

  it('moves to another stage or clears it', () => {
    expect(stateEdits(labels, { stage: 'implement' })).toEqual({ add: ['workshop/stage:implement'], remove: ['workshop/stage:design'] });
    expect(stateEdits(labels, { stage: null })).toEqual({ add: [], remove: ['workshop/stage:design'] });
  });

  it('replaces or clears the size', () => {
    expect(stateEdits(labels, { size: 'xl' })).toEqual({ add: ['workshop/size:xl'], remove: ['workshop/size:m'] });
    expect(stateEdits(labels, { size: null })).toEqual({ add: [], remove: ['workshop/size:m'] });
  });

  it('adds and removes flags', () => {
    expect(stateEdits(labels, { needsInfo: true, skip: true, failed: false })).toEqual({ add: ['workshop/needs-info', 'workshop/skip'], remove: [] });
    expect(stateEdits([...labels, 'workshop/failed'], { failed: false })).toEqual({ add: [], remove: ['workshop/failed'] });
  });

  it('leaves omitted fields, running and other labels alone', () => {
    expect(stateEdits(labels, {})).toEqual({ add: [], remove: [] });
  });

  it('gives no edits when the patch matches the labels', () => {
    expect(stateEdits(labels, { stage: 'design', size: 'm', skip: false })).toEqual({ add: [], remove: [] });
  });
});

describe('needs labels and the image choice', () => {
  const images = { repo: null, base: 'base', browser: 'browser' };
  const needs = parseLabels([label.needs('browser')]);
  const plain = parseLabels([]);

  it('parses needs from labels', () => {
    expect(parseLabels([label.needs('browser')]).needs).toEqual(['browser']);
    expect(plain.needs).toEqual([]);
  });

  it('addNeeds only adds', () => {
    expect(addNeeds([], ['browser'])).toEqual({ add: [label.needs('browser')], remove: [] });
    expect(addNeeds([label.needs('browser')], ['browser'])).toEqual({ add: [], remove: [] });
    expect(addNeeds([label.needs('browser')], [])).toEqual({ add: [], remove: [] });
  });

  it('gives the browser image to implementation on a ticket that needs it', () => {
    expect(imageFor('implement', needs, images)).toBe('browser');
    expect(imageFor('implement', plain, images)).toBe('base');
    for (const agent of ['classifier', 'design', 'design-review', 'merge'] as const) expect(imageFor(agent, needs, images)).toBe('base');
  });

  it("always uses a repository's own image", () => {
    for (const agent of ['implement', 'design'] as const) expect(imageFor(agent, needs, { ...images, repo: 'mine' })).toBe('mine');
  });
});

describe('capabilities', () => {
  it('parses the capabilities label', () => {
    expect(capabilitiesOf({})).toEqual([]);
    expect(capabilitiesOf({ 'workshop.capabilities': ' Browser, ,gpu,browser', other: 'x' })).toEqual(['browser', 'gpu']);
    expect(capabilitiesOf({ other: 'browser' })).toEqual([]);
  });

  it('describes the environment to the agent', () => {
    expect(environmentText(['browser'])).toContain('playwright screenshot');
    expect(environmentText([])).toContain('No browser is installed');
    expect(environmentText([])).toContain('workshop/needs:browser');
    expect(environmentText(['browser', 'gpu'])).toContain('gpu');
  });
});
