import { describe, expect, it } from 'vitest';
import type { DependencyGraph, DependencyNode, TicketView } from '../../server/src/api-types.ts';
import { ticketStatus } from '../src/format.ts';
import { clip, layoutGraph, NODE_H, nodeStatus } from '../src/graph.ts';

const view = (over: Partial<TicketView> = {}): TicketView => ({
  id: 1,
  repo: 'me/app',
  number: 1,
  title: 'T',
  url: 'u',
  author: 'me',
  state: 'open',
  labels: [],
  size: null,
  stage: null,
  needsInfo: false,
  skipped: false,
  failed: false,
  nominated: null,
  next: null,
  branch: null,
  prNumber: null,
  prUrl: null,
  prStatus: null,
  activeRunId: null,
  attention: null,
  dismissed: false,
  push: null,
  prioritised: false,
  bypassLimits: false,
  mediaCount: 0,
  updatedAt: 'x',
  ...over,
});
const node = (n: number, over: Partial<DependencyNode> = {}): DependencyNode => ({ ref: `#${n}`, number: n, title: `Ticket ${n}`, url: 'u', state: 'open', held: false, ticket: view({ number: n }), ...over });
const graph = (nodes: DependencyNode[], links: [number, number][]): Pick<DependencyGraph, 'nodes' | 'edges'> => ({
  nodes,
  edges: links.map(([b, t]) => ({ blocker: `#${b}`, ticket: `#${t}` })),
});
const cols = (g: Pick<DependencyGraph, 'nodes' | 'edges'>, opts = {}) => Object.fromEntries(layoutGraph(g, opts).nodes.map((p) => [p.node.ref, p.col]));

describe('layoutGraph', () => {
  it('puts a chain in columns 0, 1, 2', () => {
    expect(cols(graph([node(1), node(2), node(3)], [[1, 2], [2, 3]]))).toEqual({ '#1': 0, '#2': 1, '#3': 2 });
  });

  it('puts the join of a diamond after its longest path', () => {
    // 1 blocks 2 and 3, which both block 4; 1 also blocks 4 directly.
    expect(cols(graph([node(1), node(2), node(3), node(4)], [[1, 2], [1, 3], [2, 4], [3, 4], [1, 4]]))).toEqual({ '#1': 0, '#2': 1, '#3': 1, '#4': 2 });
  });

  it('puts a ticket that waits for nothing just before the first ticket it blocks', () => {
    expect(cols(graph([node(1), node(2), node(3), node(4)], [[1, 2], [2, 3], [4, 3]]))).toEqual({ '#1': 0, '#2': 1, '#3': 2, '#4': 1 });
  });

  it('routes a link that skips a column through a free slot, not behind a ticket', () => {
    // 1 → 2 → 3 and 1 → 3: the long link passes column 1 below #2.
    const l = layoutGraph(graph([node(1), node(2), node(3)], [[1, 2], [2, 3], [1, 3]]));
    const long = l.edges.find((e) => e.blocker === '#1' && e.ticket === '#3')!;
    const two = l.nodes.find((p) => p.node.ref === '#2')!;
    const [, ly] = long.path.match(/L [\d.]+ ([\d.]+)/)!.map(Number);
    expect(ly < two.y || ly > two.y + NODE_H).toBe(true);
    expect(l.height).toBeGreaterThanOrEqual(ly);
  });

  it('breaks a cycle and still draws every link', () => {
    const l = layoutGraph(graph([node(1), node(2), node(3)], [[1, 2], [2, 3], [3, 1]]));
    expect(l.nodes.map((p) => p.col)).toEqual([0, 1, 2]);
    expect(l.edges).toHaveLength(3);
    expect(l.edges.filter((e) => e.cycle).map((e) => `${e.blocker}>${e.ticket}`)).toEqual(['#3>#1']);
  });

  it('stacks separate trees without overlapping', () => {
    const l = layoutGraph(graph([node(1), node(2), node(3), node(4), node(5)], [[1, 2], [1, 3], [4, 5]]));
    const band = (refs: string[]) => l.nodes.filter((p) => refs.includes(p.node.ref));
    const first = band(['#1', '#2', '#3']);
    const second = band(['#4', '#5']);
    expect(Math.min(...second.map((p) => p.y))).toBeGreaterThanOrEqual(Math.max(...first.map((p) => p.y)) + NODE_H);
    expect(l.height).toBeGreaterThanOrEqual(Math.max(...l.nodes.map((p) => p.y)) + NODE_H);
    // Within a column, no two boxes share a row.
    const keys = l.nodes.map((p) => `${p.x},${p.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('drops closed tickets and their links when asked', () => {
    const g = graph([node(1, { state: 'closed' }), node(2), node(3)], [[1, 2], [2, 3]]);
    const l = layoutGraph(g, { hideClosed: true });
    expect(l.nodes.map((p) => p.node.ref)).toEqual(['#2', '#3']);
    expect(l.edges).toEqual([expect.objectContaining({ blocker: '#2', ticket: '#3' })]);
    expect(layoutGraph(g).edges.find((e) => e.blocker === '#1')?.done).toBe(true);
  });

  it('places each ticket near the average row of its blockers', () => {
    // #4 waits for #2 (row 1) only, #5 for #1 (row 0): #5 goes above #4.
    const l = layoutGraph(graph([node(1), node(2), node(3), node(4), node(5)], [[1, 3], [2, 3], [2, 4], [1, 5]]));
    const y = (ref: string) => l.nodes.find((p) => p.node.ref === ref)!.y;
    expect(y('#5')).toBeLessThan(y('#4'));
    expect(l.nodes.map((p) => p.node.ref)).toEqual(['#1', '#2', '#5', '#3', '#4']); // tab order: column, then row
  });

  it('ignores repeated links and links to itself', () => {
    const l = layoutGraph(graph([node(1), node(2)], [[1, 2], [1, 2], [2, 2]]));
    expect(l.edges).toHaveLength(1);
    expect(l.nodes.map((p) => p.col)).toEqual([0, 1]);
  });

  it('shares the slots of links from one blocker, so a fan-out stays short', () => {
    // #1 blocks a chain of five and every ticket in it.
    const chain: [number, number][] = [[2, 3], [3, 4], [4, 5], [5, 6]];
    const l = layoutGraph(graph([1, 2, 3, 4, 5, 6].map((n) => node(n)), [[1, 2], ...chain, ...[3, 4, 5, 6].map((n) => [1, n] as [number, number])]));
    expect(l.height).toBeLessThanOrEqual(2 * (NODE_H + 20) + 24);
  });

  it('handles an empty graph', () => {
    expect(layoutGraph(graph([], []))).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe('nodeStatus', () => {
  it('follows its order', () => {
    expect(nodeStatus(node(1, { state: 'closed', ticket: view({ activeRunId: 'r' }) }))).toEqual({ tone: 'ok', text: 'Closed' });
    expect(nodeStatus(node(1, { ticket: null }))).toEqual({ tone: 'idle', text: 'Not in Workshop' });
    expect(nodeStatus(node(1, { ticket: view({ activeRunId: 'r', failed: true }) }))).toEqual({ tone: 'running', text: 'Agent working' });
    expect(nodeStatus(node(1, { ticket: view({ skipped: true }) }))).toEqual({ tone: 'idle', text: 'Skipped' });
    expect(nodeStatus(node(1, { held: true, ticket: view({ attention: 'review', stage: 'pr-review' }) }))).toEqual({ tone: 'attention', text: 'Waiting for your review' });
    expect(nodeStatus(node(1, { held: true, ticket: view({ next: 'Depends on #2' }) }))).toEqual({ tone: 'attention', text: 'Depends on #2' });
    expect(nodeStatus(node(1, { ticket: view({ next: 'Implementation', stage: 'implement' }) }))).toEqual({ tone: 'idle', text: 'Implementation' });
    expect(nodeStatus(node(1))).toEqual({ tone: 'idle', text: 'To classify' });
  });

  it('agrees with the Tickets page for open Workshop tickets', () => {
    for (const over of [{ activeRunId: 'r' }, { failed: true }, { needsInfo: true }, { skipped: true }, { needsInfo: true, failed: true }]) {
      expect(nodeStatus(node(1, { ticket: view(over) }))).toEqual(ticketStatus(view(over)));
    }
  });
});

describe('clip', () => {
  it('cuts long text with an ellipsis', () => {
    expect(clip('Short', 10)).toBe('Short');
    expect(clip('A rather long title', 10)).toBe('A rather…');
  });
});
