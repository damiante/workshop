import { describe, expect, it } from 'vitest';
import { addNeeds, agentSize, applyEdits, branchFor, describeStep, labelDiff, imageFor, label, nextStep, parseLabels, stageAfterClassify, stateEdits } from '../src/workflow/labels.ts';
import { parseResult, schemaFor, type Finding, type Rescue } from '../src/workflow/schemas.ts';
import { MAX_FINDINGS_SHOWN, MAX_REWORKS, planTransition, reviewSection, stageForRework, type PlanContext } from '../src/workflow/transitions.ts';
import { capabilitiesOf, DEFAULT_PROMPTS, environmentText, INDEX_PATH, protocolText, SEARCH_INDEX, taskPrompt } from '../src/workflow/prompts.ts';
import { isDuplicate, keywords, similarity } from '../src/workflow/similar.ts';
import { stepPriority } from '../src/scheduler/gates.ts';

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
    rework: null,
    mergeWithoutReview: false,
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

  it('implement pushes, stores its summary and goes to code review without opening the PR', () => {
    const labels = [label.size('s'), label.stage('implement')];
    const plan = planTransition(ctx({ agent: 'implement', labels }), { outcome: 'done', summary: 'ok' });
    expect(plan).toMatchObject({ add: [label.stage('code-review')], remove: [label.stage('implement')], publish: true, handOff: true });
    expect(plan.openPr).toBeUndefined();
    expect(plan.comment).toContain('Next: code review.');
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
    for (const blocked_by of [undefined, []]) {
      expect(parseResult('classifier', { decision: 'blocked', blocked_by, reason: 'x' })).toBe('blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).');
    }
    for (const blocked_by of [['2'], [0], [1.5]]) {
      expect(parseResult('classifier', { decision: 'blocked', blocked_by, reason: 'x' })).toBe('blocked_by must be a list of ticket numbers.');
    }
  });

  it('accepts new prerequisite tickets instead of, or beside, numbers', () => {
    const raise_blockers = [{ title: 'Save modifiers', body: 'Build it.' }];
    expect(parseResult('classifier', { decision: 'blocked', raise_blockers, reason: 'x' })).toMatchObject({ raise_blockers });
    expect(parseResult('classifier', { decision: 'blocked', blocked_by: [], raise_blockers, reason: 'x' })).toMatchObject({ raise_blockers });
    expect(parseResult('classifier', { decision: 'blocked', blocked_by: [2], raise_blockers, reason: 'x' })).toMatchObject({ blocked_by: [2], raise_blockers });
    expect(parseResult('classifier', { decision: 'blocked', raise_blockers: [{ title: ' ', body: 'b' }], reason: 'x' })).toBe('raise_blockers must be a list of { title, body }.');
    expect(parseResult('classifier', { decision: 'blocked', raise_blockers: [], reason: 'x' })).toMatch(/^blocked requires blocked_by/);
  });

  it('lets only Design and Implementation return blocked, and only with raise_blockers', () => {
    const raise_blockers = [{ title: 'T', body: 'B' }];
    for (const agent of ['design', 'implement'] as const) {
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', raise_blockers })).toMatchObject({ outcome: 'blocked', raise_blockers });
      expect(parseResult(agent, { outcome: 'blocked', summary: 's' })).toBe('blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).');
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', raise_blockers: [{ title: 'T' }] })).toBe('raise_blockers must be a list of { title, body }.');
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', blocked_by: [4] })).toMatchObject({ outcome: 'blocked', blocked_by: [4] });
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', blocked_by: [] })).toMatch(/^blocked requires blocked_by/);
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', blocked_by: ['4'] })).toBe('blocked_by must be a list of ticket numbers.');
    }
    for (const agent of ['code-review', 'merge', 'design-review'] as const) {
      expect(parseResult(agent, { outcome: 'blocked', summary: 's', raise_blockers })).toBe('outcome must be done, needs_info or failed.');
    }
    expect(parseResult('design', { outcome: 'nope', summary: 's' })).toBe('outcome must be done, needs_info, failed or blocked.');
  });
});

describe('raising blockers', () => {
  it('adds raise_blockers to the schema only with the flag, and the blocked outcome only for Design and Implementation', () => {
    expect(schemaFor('classifier')).not.toHaveProperty('properties.raise_blockers');
    expect(schemaFor('classifier', { blockers: true })).toHaveProperty('properties.raise_blockers.maxItems', 3);
    expect(schemaFor('classifier', { blockers: true })).toHaveProperty('properties.blocked_by.description', expect.stringContaining('may be empty when raise_blockers is given'));
    expect(schemaFor('design')).toHaveProperty('properties.outcome.enum', ['done', 'needs_info', 'failed']);
    expect(schemaFor('design', { blockers: true })).toHaveProperty('properties.outcome.enum', ['done', 'needs_info', 'failed', 'blocked']);
    expect(schemaFor('implement', { blockers: true, noticed: true })).toHaveProperty('properties.raise_blockers.items.required', ['title', 'body']);
    expect(schemaFor('implement', { blockers: true, noticed: true })).toHaveProperty('properties.noticed');
    expect(schemaFor('implement', { blockers: true })).toHaveProperty('properties.blocked_by.items.type', 'integer');
    expect(schemaFor('implement')).not.toHaveProperty('properties.blocked_by');
    for (const agent of ['code-review', 'merge', 'design-review'] as const) {
      expect(schemaFor(agent, { blockers: true })).not.toHaveProperty('properties.raise_blockers');
      expect(schemaFor(agent, { blockers: true })).toHaveProperty('properties.outcome.enum', ['done', 'needs_info', 'failed']);
    }
  });

  it('classify blocked with numbers only keeps the plan and comment as before', () => {
    const plan = planTransition(ctx(), { decision: 'blocked', blocked_by: [2, 5], reason: 'Needs the API.' });
    expect(plan).toEqual({
      add: [],
      remove: [],
      addBlockers: [2, 5],
      comment: "Workshop will wait for #2 and #5 before working on this ticket: Needs the API.\n\nIt carries on once they're closed. If it shouldn't wait, remove the link under Relationships and say so in a comment.",
    });
  });

  it('classify blocked with raise_blockers asks for the tickets, with no labels', () => {
    const raise_blockers = [{ title: 'Save modifiers', body: 'Build it.' }];
    const plan = planTransition(ctx(), { decision: 'blocked', raise_blockers, reason: 'Needs modifiers.' });
    expect(plan).toMatchObject({ add: [], remove: [], raiseBlockers: raise_blockers });
    expect(plan.addBlockers).toBeUndefined();
    expect(plan.comment).toContain('Workshop will wait for the prerequisite tickets listed below before working on this ticket: Needs modifiers.');
    const both = planTransition(ctx(), { decision: 'blocked', blocked_by: [2], raise_blockers, reason: 'x' });
    expect(both).toMatchObject({ addBlockers: [2], raiseBlockers: raise_blockers });
    expect(both.comment).toContain('wait for #2 and the prerequisite tickets listed below');
  });

  it.each(['design', 'implement'] as const)('%s blocked publishes the work, keeps the stage and raises the prerequisites', (agent) => {
    const labels = [label.size('l'), label.stage(agent)];
    const raise_blockers = [{ title: 'T', body: 'B' }];
    const plan = planTransition(ctx({ agent, labels }), { outcome: 'blocked', summary: 'Needs T first.', raise_blockers });
    expect(plan).toMatchObject({ add: [], remove: [], publish: true, raiseBlockers: raise_blockers });
    expect(plan.failure).toBeUndefined();
    expect(plan.handOff).toBeUndefined();
    expect(plan.comment).toContain('Needs T first.');
  });

  it.each(['design', 'implement'] as const)('%s blocked on an open ticket links it', (agent) => {
    const plan = planTransition(ctx({ agent, labels: [label.size('l'), label.stage(agent)] }), { outcome: 'blocked', summary: 'Needs #4 first.', blocked_by: [4] });
    expect(plan).toMatchObject({ publish: true, addBlockers: [4] });
    expect(plan.raiseBlockers).toBeUndefined();
    expect(plan.comment).toContain('Workshop will wait for #4 before working on this ticket');
  });

  it('puts the blocker rule in the protocol and the classifier task only with the flag', () => {
    const plain = protocolText({ branch: 'b', base: 'main', noticed: true });
    expect(plain).not.toContain('raise_blockers');
    expect(plain).toContain("don't let it stop you. List it");
    const both = protocolText({ branch: 'b', base: 'main', noticed: true, blockers: true });
    expect(both).toContain('Return "blocked" with that work under "raise_blockers"');
    expect(both).toContain("don't let it stop you (if it does, see the next rule)");
    expect(protocolText({ branch: 'b', base: 'main', blockers: true })).toContain('raise_blockers');
    expect(both).toContain(SEARCH_INDEX);
    expect(both).toContain('return "blocked" with its number under "blocked_by" instead');
    expect(plain).not.toContain(INDEX_PATH);

    const task = {
      agent: 'classifier' as const,
      mode: 'normal' as const,
      repo: 'me/app',
      base: 'main',
      branch: 'b',
      docPath: 'd.md',
      ticket: { number: 3, title: 'X', body: 'Do X', url: 'u', labels: [], size: null },
      comments: [],
      omittedComments: 0,
      review: [],
      ui: false,
      media: [],
    };
    const openTickets = [{ number: 2, title: 'API', body: '' }];
    expect(taskPrompt({ ...task, openTickets })).toContain('return "blocked" with their numbers in blocked_by and the reason.');
    expect(taskPrompt({ ...task, openTickets })).not.toContain('raise_blockers');
    expect(taskPrompt(task)).not.toContain('blocked');
    const listed = taskPrompt({ ...task, openTickets, raiseBlockers: true });
    expect(listed).toContain('put the numbers of the open tickets that cover it in blocked_by, and describe prerequisite work that no open ticket covers under raise_blockers');
    expect(listed).toContain(`search \`${INDEX_PATH}\``);
    expect(listed).not.toContain('open tickets are in');
    expect(taskPrompt({ ...task, openTickets, raiseBlockers: true, indexed: 35 })).toContain(`All 35 open tickets are in \`${INDEX_PATH}\`.`);
    const none = taskPrompt({ ...task, raiseBlockers: true });
    expect(none).toContain('prerequisite work outside its scope exists, return "blocked" and describe that work under raise_blockers');
    expect(none).not.toContain('blocked_by');
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
        { name: 'multi.png', source: 'Implementation', runId: null, caption: 'One\ntwo' },
      ],
    });
    expect(prompt).toContain('- /work/media/issue-1.png: from the issue');
    expect(prompt).toContain('- /work/media/comment-1.png: from a comment');
    expect(prompt).toContain('- /work/media/after.png: added by Implementation (run abcdef12): Dark mode');
    expect(prompt).toContain('- /work/media/multi.png: added by Implementation: One two');
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
    const ctx: PlanContext = { agent: 'classifier', mode: 'normal', labels: [], state: parseLabels([]), author: 'me', docPath: 'd.md', docUrl: 'u', rework: null, mergeWithoutReview: false };
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

  it('sizes the container by the agent and the ticket', () => {
    const plain = parseLabels([label.size('m')]);
    const xl = parseLabels([label.size('xl')]);
    const browser = parseLabels([label.size('s'), label.needs('browser')]);
    expect(agentSize('classifier', xl, true)).toBe('small');
    for (const agent of ['design', 'design-review', 'implement', 'code-review', 'merge'] as const) expect(agentSize(agent, plain)).toBe('standard');
    // Whoever drives a browser is large: the same agents that get the browser image.
    expect(agentSize('implement', browser)).toBe('large');
    expect(agentSize('code-review', browser)).toBe('large');
    expect(agentSize('design', browser)).toBe('standard');
    expect(agentSize('design', plain, true)).toBe('large');
    expect(agentSize('design-review', plain, true)).toBe('large');
    // On an XL ticket, the agents that build and run the code are large.
    expect(agentSize('implement', xl)).toBe('large');
    expect(agentSize('code-review', xl)).toBe('large');
    expect(agentSize('design', xl)).toBe('standard');
    expect(agentSize('merge', xl)).toBe('standard');
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

describe('reconcile (a rescued push)', () => {
  const rescue = (over: Partial<Rescue> = {}): Rescue => ({ branch: 'workshop/1-x-unmerged-abc', runId: 'run-1', agent: 'implement', mode: 'normal', result: { outcome: 'done', summary: 'Built it.' }, ...over });
  const reconcileCtx = (r: Rescue | undefined, size = 's') => {
    const labels = [label.size(size as 's'), label.stage('reconcile')];
    return ctx({ agent: 'merge', labels, state: parseLabels(labels), rescue: r });
  };
  const merged = { outcome: 'done' as const, summary: 'Resolved CLAUDE.md.' };

  it('reconcile is a Merge agent step', () => {
    expect(step([label.stage('reconcile')])).toEqual({ kind: 'agent', agent: 'merge', mode: 'normal' });
  });

  it('labelDiff and applyEdits are inverses', () => {
    const diff = labelDiff(['a', 'b'], ['b', 'c']);
    expect(diff).toEqual({ add: ['c'], remove: ['a'] });
    expect(applyEdits(['a', 'b'], diff).sort()).toEqual(['b', 'c']);
  });

  it('finishes an Implementation rescue: code review next with the handoff, branch cleanup', () => {
    const plan = planTransition(reconcileCtx(rescue()), merged);
    expect(plan).toMatchObject({ publish: true, handOff: true, deleteBranch: 'workshop/1-x-unmerged-abc', clearRescue: true });
    expect(plan.openPr).toBeUndefined();
    expect(plan.add).toEqual([label.stage('code-review')]);
    expect(plan.remove).toEqual([label.stage('reconcile')]);
    expect(plan.comment).toContain('Resolved CLAUDE.md.');
  });

  it('finishes a Design rescue on an M ticket: implement next, both comments', () => {
    const plan = planTransition(reconcileCtx(rescue({ agent: 'design', result: { outcome: 'done', summary: 'Designed.' } }), 'm'), merged);
    expect(plan.add).toEqual([label.stage('implement')]);
    expect(plan.remove).toEqual([label.stage('reconcile')]);
    expect(plan.comment).toContain('Resolved CLAUDE.md.');
    expect(plan.comment).toContain('Design written');
  });

  it('a stored needs_info result restores the question', () => {
    const plan = planTransition(reconcileCtx(rescue({ result: { outcome: 'needs_info', summary: 's', questions: ['Which?'] } })), merged);
    expect(plan.add).toContain(label.needsInfo);
    expect(plan.comment).toContain('Which?');
  });

  it('fails when Workshop has no saved work', () => {
    expect(planTransition(reconcileCtx(undefined), merged).failure).toContain('Nothing to reconcile');
  });

  it('the Merge agent in the merge stage is unchanged', () => {
    const labels = [label.stage('merge')];
    expect(planTransition(ctx({ agent: 'merge', labels, state: parseLabels(labels) }), merged)).toMatchObject({ publish: true, merge: true });
  });

  it('the task names the rescue branch', () => {
    const prompt = taskPrompt({
      agent: 'merge', mode: 'normal', repo: 'me/app', base: 'main', branch: 'workshop/3-x', docPath: 'd.md',
      ticket: { number: 3, title: 'X', body: 'Do X', url: 'u', labels: [], size: null },
      comments: [], omittedComments: 0, review: [], ui: false, media: [],
      rescue: { branch: 'workshop/3-x-unmerged-abc', agent: 'implement', summary: 'Built it.' },
    });
    expect(prompt).toContain('git merge origin/workshop/3-x-unmerged-abc');
  });
});

describe('attentionOf', () => {
  const base = { needsInfo: false, failed: false, stage: null, activeRunId: null, prStatus: null, skipped: false } as const;
  it('says why a ticket needs you, in order of precedence', async () => {
    const { attentionOf } = await import('../src/tickets.ts');
    expect(attentionOf(base)).toBeNull();
    expect(attentionOf({ ...base, stage: 'pr-review' })).toBe('review');
    expect(attentionOf({ ...base, stage: 'pr-review', failed: true })).toBe('failed');
    expect(attentionOf({ ...base, stage: 'pr-review', failed: true, needsInfo: true })).toBe('question');
    expect(attentionOf({ ...base, stage: 'pr-review', activeRunId: 'r' })).toBeNull();
    expect(attentionOf({ ...base, stage: 'pr-review', prStatus: 'changes_requested' })).toBeNull();
    expect(attentionOf({ ...base, stage: 'pr-review', failed: true, skipped: true })).toBeNull();
  });
});

describe('code review', () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    severity: 'severe',
    cause: 'implementation',
    title: 'Crashes on empty input',
    detail: 'parse() throws on an empty string.',
    evidence: 'Ran npm test: 1 failed.',
    fix: 'Return null for empty input.',
    file: 'src/a.ts',
    line: 4,
    ...over,
  });
  const reviewCtx = (size: 's' | 'm' | 'l' | 'xl' = 's', over: Partial<PlanContext> = {}) => {
    const labels = [label.size(size), label.stage('code-review')];
    return ctx({ agent: 'code-review', labels, ...over });
  };
  const done = (findings: Finding[], over: object = {}) => ({ outcome: 'done' as const, summary: 'Looks mostly fine.', findings, ...over });

  it('is an agent step at implementation priority, called Code review', () => {
    const s = step([label.stage('code-review')]);
    expect(s).toEqual({ kind: 'agent', agent: 'code-review', mode: 'normal' });
    expect(describeStep(s)).toBe('Code review');
    expect(stepPriority(s!)).toBe(1);
  });

  it('gets the browser image on a ticket that needs one', () => {
    const images = { repo: null, base: 'base', browser: 'browser' };
    expect(imageFor('code-review', parseLabels([label.needs('browser')]), images)).toBe('browser');
    expect(imageFor('code-review', parseLabels([]), images, true)).toBe('base');
  });

  describe('stageForRework', () => {
    it('returns null without a severe finding, even when moderate ones blame the design', () => {
      expect(stageForRework('l', [])).toBeNull();
      expect(stageForRework('l', [finding({ severity: 'moderate', cause: 'design' }), finding({ severity: 'minor' })])).toBeNull();
    });
    it('sends implementation causes back to implementation', () => {
      expect(stageForRework('xl', [finding()])).toBe('implement');
    });
    it('sends design causes back to design on M, L and XL, and to implementation on XS and S', () => {
      for (const size of ['m', 'l', 'xl'] as const) expect(stageForRework(size, [finding(), finding({ cause: 'design' })])).toBe('design');
      for (const size of ['xs', 's'] as const) expect(stageForRework(size, [finding({ cause: 'design' })])).toBe('implement');
      expect(stageForRework(null, [finding({ cause: 'design' })])).toBe('implement');
    });
  });

  it('opens the PR with the findings when nothing is severe', () => {
    for (const findings of [[], [finding({ severity: 'moderate', title: 'No test for X' }), finding({ severity: 'minor', title: 'Rename y' })]]) {
      const plan = planTransition(reviewCtx(), done(findings, { tests: 'npm test: 3 passed' }));
      expect(plan).toMatchObject({ add: [label.stage('pr-review')], remove: [label.stage('code-review')], openPr: true, rework: null });
      expect(plan.publish).toBeUndefined();
      expect(plan.flagged).toBeUndefined();
      expect(plan.comment).toBeUndefined();
      expect(plan.reviewNotes).toMatch(/^### Code review/);
      expect(plan.reviewNotes).toContain('**Reviewer ran:** npm test: 3 passed');
      if (findings.length) {
        expect(plan.reviewNotes).toContain('- **Moderate** (`src/a.ts:4`) No test for X: parse() throws');
        expect(plan.reviewNotes).toContain('Checked: Ran npm test');
        expect(plan.reviewNotes).toContain('Fix: Return null');
        expect(plan.reviewNotes!.indexOf('Moderate')).toBeLessThan(plan.reviewNotes!.indexOf('Minor'));
      } else expect(plan.reviewNotes).toContain('No problems found.');
    }
  });

  it('sends severe findings back once, storing them, without publishing or opening the PR', () => {
    const plan = planTransition(reviewCtx(), done([finding({ severity: 'minor', title: 'Nit' }), finding()]));
    expect(plan).toMatchObject({ add: [label.stage('implement')], remove: [label.stage('code-review')] });
    expect(plan.publish).toBeUndefined();
    expect(plan.openPr).toBeUndefined();
    expect(plan.rework).toEqual({ count: 1, findings: [finding()] });
    expect(plan.comment).toContain('Code review found 1 severe problem, so Workshop sends this ticket back to implementation (rework 1 of 3):');
    expect(plan.comment).toContain('Crashes on empty input');
    expect(plan.comment).not.toContain('Nit');
    expect(plan.comment).toMatch(/Next: implementation\.$/);

    const design = planTransition(reviewCtx('l'), done([finding({ cause: 'design' })]));
    expect(design.add).toEqual([label.stage('design')]);
    expect(design.comment).toContain('back to design');
  });

  it('sends a new severe finding back again after a rework, up to MAX_REWORKS', () => {
    // Ticket 230: the rework fixed the first finding, and the next review found a different one.
    const rework = { count: 1, findings: [finding()] };
    const plan = planTransition(reviewCtx('s', { rework }), done([finding({ title: 'Test crashes without data' })]));
    expect(plan).toMatchObject({ add: [label.stage('implement')], rework: { count: 2, findings: [finding({ title: 'Test crashes without data' })] } });
    expect(plan.comment).toContain('(rework 2 of 3)');
    const capped = planTransition(reviewCtx('s', { rework: { ...rework, count: MAX_REWORKS } }), done([finding()]));
    expect(capped).toMatchObject({ add: [label.stage('pr-review')], openPr: true, flagged: true });
    // repeat means nothing on a round's first review.
    expect(planTransition(reviewCtx(), done([finding({ repeat: true })])).add).toEqual([label.stage('implement')]);
  });

  it('opens the PR flagged when a severe finding the rework was for still holds', () => {
    const rework = { count: 1, findings: [finding()] };
    const plan = planTransition(reviewCtx('s', { rework }), done([finding({ title: 'New one' }), finding({ repeat: true })]));
    expect(plan).toMatchObject({ add: [label.stage('pr-review')], openPr: true, rework: null, flagged: true });
    expect(plan.reviewNotes).toContain("still found severe problems after Workshop's rework");
    expect(plan.reviewNotes!.indexOf('still found')).toBeLessThan(plan.reviewNotes!.indexOf('Crashes'));
    expect(plan.add).not.toContain(label.needsInfo);
    expect(plan.comment).toBeUndefined();
  });

  it('goes straight to merge, with no pull request, in a repository that pushes to its default branch', () => {
    const plan = planTransition(reviewCtx('s', { pushToDefault: true }), done([finding({ severity: 'minor' })]));
    expect(plan.add).toEqual([label.stage('merge')]);
    expect(plan).toMatchObject({ merge: true, noPr: true, rework: null });
    expect(plan.openPr).toBeUndefined();
    expect(plan.comment).toContain('### Code review');
    expect(plan.comment).toContain('Next: Workshop pushes this to the default branch.');
  });

  it("waits for you instead of pushing when a rework didn't fix a severe problem", () => {
    const rework = { count: 1, findings: [finding()] };
    const plan = planTransition(reviewCtx('s', { rework, pushToDefault: true }), done([finding({ repeat: true })]));
    expect(plan.add).toEqual([label.stage('merge'), label.needsInfo]);
    expect(plan.merge).toBeUndefined();
    expect(plan.comment).toMatch(/^@damiante .*won't push this to the default branch without you/);
    expect(plan.comment).toContain('Crashes on empty input');
  });

  it('keeps using a pull request the ticket already has', () => {
    const plan = planTransition(reviewCtx('s', { pushToDefault: true, hasPr: true }), done([]));
    expect(plan.add).toEqual([label.stage('pr-review')]);
    expect(plan.openPr).toBe(true);
  });

  it('holds the PR with needs-info when it would merge without review', () => {
    const rework = { count: 1, findings: [finding()] };
    const plan = planTransition(reviewCtx('s', { rework, mergeWithoutReview: true }), done([finding({ repeat: true })]));
    expect(plan.add).toEqual([label.stage('pr-review'), label.needsInfo]);
    expect(plan.comment).toMatch(/^@damiante .*won't merge this pull request without you/);
    // Nothing severe: no hold.
    expect(planTransition(reviewCtx('s', { rework, mergeWithoutReview: true }), done([])).add).toEqual([label.stage('pr-review')]);
  });

  it('asks questions without publishing', () => {
    const plan = planTransition(reviewCtx(), { outcome: 'needs_info', summary: '', questions: ['Which?'] });
    expect(plan).toMatchObject({ add: [label.needsInfo], publish: false });
  });

  it('a new classification clears the rework state', () => {
    const rework = { count: 1, findings: [finding()] };
    expect(planTransition(ctx({ rework }), { decision: 'accept', size: 's', reason: 'x' }).rework).toBeNull();
    const labels = [label.size('s'), label.stage('reclassify')];
    expect(planTransition(ctx({ labels, mode: 'delta', rework }), { decision: 'accept', size: 's', reason: 'x' }).rework).toBeNull();
  });

  it('caps the findings shown and cuts long text', () => {
    const many = Array.from({ length: MAX_FINDINGS_SHOWN + 5 }, (_, i) => finding({ severity: i === 34 ? 'severe' : 'minor', title: `T${i}`, detail: 'd'.repeat(3000) }));
    const notes = reviewSection(done(many), false);
    expect(notes.indexOf('T34')).toBeLessThan(notes.indexOf('T0:'));
    expect(notes.match(/^- \*\*/gm)).toHaveLength(MAX_FINDINGS_SHOWN);
    expect(notes).toContain("5 more findings left out; see the Code reviewer's run.");
    expect(notes).toContain(`${'d'.repeat(1000)}…`);
    expect(notes).not.toContain('d'.repeat(1001));
    expect(notes.length).toBeLessThan(65_536);
  });

  it('stays well under GitHub\'s body limit however long the fields are', () => {
    const long = 'x'.repeat(20_000);
    const many = Array.from({ length: 40 }, () => finding({ title: long, detail: long, evidence: long, fix: long, file: `a\`b${long}` }));
    const notes = reviewSection(done(many, { summary: long }), true);
    expect(notes.length).toBeLessThan(50_000);
    expect(notes).toMatch(/\d+ more findings left out/);
    expect(notes).not.toContain('a`b');
  });

  it('requires findings in the schema given to Claude', () => {
    expect(schemaFor('code-review')).toMatchObject({ required: ['outcome', 'summary', 'findings'] });
    expect(schemaFor('implement')).toMatchObject({ required: ['outcome', 'summary'] });
    expect(schemaFor('implement')).not.toHaveProperty('properties.noticed');
    expect(schemaFor('implement', { noticed: true })).toHaveProperty('properties.noticed.items.required', ['title', 'body']);
    expect(schemaFor('code-review', { noticed: true })).toHaveProperty('properties.findings');
    expect(schemaFor('classifier', { noticed: true })).not.toHaveProperty('properties.noticed');
    expect(parseResult('implement', { outcome: 'done', summary: 's', noticed: [{ title: 't', body: 'b' }] })).toMatchObject({ noticed: [{ title: 't' }] });
    expect(parseResult('implement', { outcome: 'done', summary: 's', noticed: [{ title: 't' }] })).toBe('noticed must be a list of { title, body }.');
  });

  describe('parseResult', () => {
    it('requires findings when done, and accepts an empty list', () => {
      expect(parseResult('code-review', { outcome: 'done', summary: 's' })).toMatch(/^findings must be a list of \{ severity, cause, title, detail, evidence, fix \}/);
      expect(parseResult('code-review', done([]))).toMatchObject({ findings: [] });
      expect(parseResult('code-review', done([finding()]))).toMatchObject({ findings: [finding()] });
      expect(parseResult('code-review', done([finding({ file: undefined, line: undefined })]))).toMatchObject({ outcome: 'done' });
      expect(parseResult('code-review', { outcome: 'failed', summary: 's' })).toMatchObject({ outcome: 'failed' });
    });
    it('rejects a bad severity, cause, fix, evidence or line', () => {
      for (const bad of [{ severity: 'critical' }, { cause: 'tests' }, { fix: '' }, { evidence: undefined }, { line: 0 }, { line: 1.5 }, { file: 3 }]) {
        expect(parseResult('code-review', done([finding(bad as Partial<Finding>)]))).toMatch(/^findings must be/);
      }
    });
    it('other agents ignore findings', () => {
      expect(parseResult('implement', { outcome: 'done', summary: 's' })).toMatchObject({ outcome: 'done' });
    });
  });

  describe('prompts', () => {
    const base = {
      mode: 'normal' as const,
      repo: 'me/app',
      base: 'main',
      branch: 'workshop/3-x',
      docPath: 'd.md',
      ticket: { number: 3, title: 'X', body: 'Do X', url: 'u', labels: [], size: 'l' as const },
      comments: [],
      omittedComments: 0,
      review: [],
      ui: false,
      media: [],
    };
    const rework = { count: 1, findings: [finding()] };

    it("gives the reviewer its task, the review feedback check and the earlier findings", () => {
      const plain = taskPrompt({ ...base, agent: 'code-review' });
      expect(plain).toContain('Review the work on branch `workshop/3-x` (compare with `git diff origin/main...HEAD`) against the ticket and the design at `d.md`');
      expect(plain).not.toContain('review feedback above');
      expect(plain).not.toContain('previous code review');
      const reviewed = taskPrompt({ ...base, agent: 'code-review', review: [{ author: 'me', body: 'Rename' }], rework });
      expect(reviewed).toContain('Check that the review feedback above was addressed.');
      expect(reviewed).toContain('## Severe findings from the previous code review');
      expect(reviewed).toContain('Crashes on empty input');
      expect(reviewed).toContain('Check each one again');
    });

    it('lists the findings to fix for design, design review and implementation during a rework only', () => {
      for (const agent of ['design', 'design-review', 'implement'] as const) {
        expect(taskPrompt({ ...base, agent })).not.toContain('Code review findings');
        const prompt = taskPrompt({ ...base, agent, rework });
        expect(prompt).toContain('## Code review findings to fix');
        expect(prompt).toContain('- **Severe** (`src/a.ts:4`) Crashes on empty input');
      }
      expect(taskPrompt({ ...base, agent: 'design', rework })).toContain("The code review found that the design at `d.md` doesn't work");
      expect(taskPrompt({ ...base, agent: 'design', rework })).not.toContain('Write the design');
      expect(taskPrompt({ ...base, agent: 'design', rework, review: [{ author: 'me', body: 'More' }] })).toContain('to cover the review feedback above');
      expect(taskPrompt({ ...base, agent: 'design-review', rework })).toContain('Check that the revision fixes the code review findings above.');
      expect(taskPrompt({ ...base, agent: 'implement', rework })).toContain('describe the whole change, not only the fixes');
      expect(taskPrompt({ ...base, agent: 'merge', rework })).not.toContain('Code review findings');
    });

    it('no longer asks Implementation for its own adversarial review', () => {
      expect(DEFAULT_PROMPTS.implement).not.toMatch(/adversarial|subagent/);
      expect(DEFAULT_PROMPTS['code-review']).toContain("When in doubt, it isn't severe");
    });

    it("doesn't tell the reviewer that Workshop pushes its commits", () => {
      expect(protocolText({ branch: 'b', base: 'main' })).toContain('Workshop pushes it');
      const reviewer = protocolText({ branch: 'b', base: 'main', publishes: false });
      expect(reviewer).not.toContain('Workshop pushes it');
      expect(reviewer).toContain('Workshop discards this container');
    });
  });
});

describe('similar tickets', () => {
  const t = (title: string, body = '') => ({ title, body });

  it('finds keywords: lowercase, no stop words or short words, one suffix stripped', () => {
    expect([...keywords('The Roll offers, spending and Declared dies for a pool')]).toEqual(['roll', 'offer', 'spend', 'declar', 'die', 'pool']);
    expect([...keywords('uses')]).toEqual(['use']);
    expect([...keywords('outcome outcomes saving save')]).toEqual(['outcom', 'sav']);
    expect([...keywords('data-declared add-die')]).toEqual(['data', 'declar', 'add', 'die']);
  });

  it('counts two differently worded titles for the same mechanism as duplicates', () => {
    const s = similarity(t('data-declared add-die roll offers paid from a feature pool'), t('overlay-declared roll offers that spend a resource die and add it to a roll'));
    expect(s.shared).toBe(5);
    expect(s.title).toBeCloseTo(5 / 12);
    expect(isDuplicate(s)).toBe(true);
  });

  it("doesn't count different mechanisms, or titles that share one keyword", () => {
    expect(similarity(t('Save outcome modifiers'), t('Login page crashes on an empty password'))).toEqual({ title: 0, shared: 0, text: 0 });
    expect(isDuplicate(similarity(t('Save outcome modifiers'), t('Save button styling on mobile')))).toBe(false);
    expect(isDuplicate(similarity(t('convert between spell slots and a feature resource'), t('regain uses by spending a spell slot')))).toBe(false);
  });

  // Real duplicates raised in damiante/dnd-campaigner: the first three should match; the last two are different
  // mechanisms that only share a word.
  it.each([
    ['overlay-declared roll offers that spend a resource die and add it to a roll', "data-declared feature reactions on 'attack missed you' and data-declared add-die roll offers paid from a feature pool", true],
    ['bonus Hit Points on spell-slot healing', 'heal-caster rider after a slot-cast healing spell that restores HP to another creature', true],
    ['heal-caster rider after a slot-cast healing spell that restores HP to another creature', 'trigger and rider for a spell cast with a slot that restores Hit Points', true],
    ['maximize healing dice (spells and Channel Divinity) modifier', 'spend a resource to maximise damage dice of a matching damage roll', false],
    ['feature reaction that forces a save on the creature that hit you', 'pre-damage reaction trigger that can grant resistance to one instance of damage', false],
  ])('%s vs %s: duplicate %s', (a, b, duplicate) => {
    expect(isDuplicate(similarity(t(a), t(b)))).toBe(duplicate);
  });

  it('counts strongly overlapping bodies', () => {
    const body = 'The engine needs a hook that changes the outcome of a saving throw after the roll.';
    expect(isDuplicate(similarity(t('Save outcome hook', body), t('Modify saving throws', body)))).toBe(true);
  });
});
