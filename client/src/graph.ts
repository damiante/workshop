// Pure layout for the Dependencies page: blockers on the left, the tickets they block on the right.
import type { DependencyGraph, DependencyNode } from '../../server/src/api-types.ts';
import { STAGE_TEXT, ticketStatus, type Tone } from './format.ts';

export const NODE_W = 240;
export const NODE_H = 64;
const GAP_X = 72;
const GAP_Y = 20;
/** Space between separate trees. */
const BAND_GAP = 40;
const PAD = 12;

export interface PlacedNode {
  node: DependencyNode;
  x: number;
  y: number;
  col: number;
}

export interface PlacedEdge {
  blocker: string;
  ticket: string;
  /** SVG path data, from the blocker's right edge to the ticket's left edge. */
  path: string;
  /** The blocker is closed, so this link no longer holds anything. */
  done: boolean;
  /** Part of a loop of links: drawn, but not used to place tickets. */
  cycle: boolean;
}

export interface Layout {
  /** In reading and tab order: tree by tree, then column, then top to bottom. */
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export function layoutGraph(graph: Pick<DependencyGraph, 'nodes' | 'edges'>, { hideClosed = false } = {}): Layout {
  const nodes = graph.nodes.filter((n) => !hideClosed || n.state !== 'closed');
  const index = new Map(nodes.map((n, i) => [n.ref, i]));
  const seen = new Set<string>();
  const edges = graph.edges.filter((e) => {
    const key = `${e.blocker}>${e.ticket}`;
    if (!index.has(e.blocker) || !index.has(e.ticket) || e.blocker === e.ticket || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const out = nodes.map(() => [] as number[]);
  for (const e of edges) out[index.get(e.blocker)!].push(index.get(e.ticket)!);

  // Break cycles: edges back into the current depth-first path don't count for columns.
  const back = new Set<string>();
  const mark = nodes.map(() => 0); // 0 unvisited, 1 on the path, 2 done
  const visit = (start: number) => {
    const stack: [number, number][] = [[start, 0]];
    mark[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i >= out[v].length) {
        mark[v] = 2;
        stack.pop();
        continue;
      }
      top[1]++;
      const w = out[v][i];
      if (mark[w] === 1) back.add(`${v}>${w}`);
      else if (mark[w] === 0) {
        mark[w] = 1;
        stack.push([w, 0]);
      }
    }
  };
  nodes.forEach((_, i) => mark[i] === 0 && visit(i));
  const forward = edges.map((e) => [index.get(e.blocker)!, index.get(e.ticket)!] as const).filter(([a, b]) => !back.has(`${a}>${b}`));

  // Longest-path columns, in topological order.
  const preds = nodes.map(() => [] as number[]);
  const indegree = nodes.map(() => 0);
  for (const [a, b] of forward) {
    preds[b].push(a);
    indegree[b]++;
  }
  const col = nodes.map(() => 0);
  const queue = nodes.map((_, i) => i).filter((i) => indegree[i] === 0);
  for (let q = 0; q < queue.length; q++) {
    const v = queue[q];
    for (const [a, b] of forward) {
      if (a !== v) continue;
      col[b] = Math.max(col[b], col[v] + 1);
      if (--indegree[b] === 0) queue.push(b);
    }
  }

  // Tickets that wait for nothing sit just left of the first ticket they block, so their links stay short.
  const succs = nodes.map(() => [] as number[]);
  for (const [a, b] of forward) succs[a].push(b);
  nodes.forEach((_, i) => {
    if (!preds[i].length && succs[i].length) col[i] = Math.min(...succs[i].map((s) => col[s])) - 1;
  });

  // A link that skips columns passes through a free slot in each one, so it never runs behind another ticket.
  // Links from the same blocker share their slots. Slots are numbered after the nodes; `prev` is what each node or
  // slot follows, for ordering.
  const itemCol = [...col];
  const prev = preds.map((p) => [...p]);
  const slotOf = new Map<string, number>();
  const route = new Map<string, number[]>();
  for (const [a, b] of forward) {
    const via: number[] = [];
    for (let c = col[a] + 1; c < col[b]; c++) {
      const key = `${a}@${c}`;
      if (!slotOf.has(key)) {
        slotOf.set(key, itemCol.length);
        itemCol.push(c);
        prev.push([via.length ? via[via.length - 1] : a]);
      }
      via.push(slotOf.get(key)!);
    }
    if (via.length) prev[b] = prev[b].map((p) => (p === a ? via[via.length - 1] : p));
    route.set(`${a}>${b}`, via);
  }

  // Connected groups, each in its own band, in order of their first node.
  const group = nodes.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (const e of edges) group[find(index.get(e.blocker)!)] = find(index.get(e.ticket)!);
  const bands = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const g = find(i);
    bands.set(g, [...(bands.get(g) ?? []), i]);
  });
  for (const [key, slot] of slotOf) bands.get(find(Number(key.split('@')[0])))!.push(slot);

  const placed: PlacedNode[] = [];
  const y = itemCol.map(() => 0);
  const x = (c: number) => PAD + c * (NODE_W + GAP_X);
  let top = PAD;
  let width = 0;
  for (const members of bands.values()) {
    const columns: number[][] = [];
    for (const i of members) (columns[itemCol[i]] ??= []).push(i);
    const row = new Map<number, number>();
    let rows = 0;
    columns.forEach((c = [], ci) => {
      // Each ticket sits near the average row of its blockers, so links cross less.
      const centre = (i: number) => {
        const known = prev[i].filter((p) => row.has(p));
        return known.length ? known.reduce((s, p) => s + row.get(p)!, 0) / known.length : -1;
      };
      const ordered = [...c].sort((a, b) => centre(a) - centre(b) || a - b);
      ordered.forEach((i, r) => {
        row.set(i, r);
        y[i] = top + r * (NODE_H + GAP_Y);
        if (i < nodes.length) placed.push({ node: nodes[i], x: x(ci), y: y[i], col: ci });
      });
      rows = Math.max(rows, ordered.length);
      width = Math.max(width, x(ci) + NODE_W + PAD);
    });
    top += rows * (NODE_H + GAP_Y) - GAP_Y + BAND_GAP;
  }

  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  const at = new Map(placed.map((p) => [p.node.ref, p]));
  const placedEdges = edges.map((e) => {
    const ai = index.get(e.blocker)!;
    const bi = index.get(e.ticket)!;
    const a = at.get(e.blocker)!;
    const b = at.get(e.ticket)!;
    let cx = a.x + NODE_W;
    let cy = a.y + NODE_H / 2;
    let path = `M ${cx} ${cy}`;
    for (const slot of route.get(`${ai}>${bi}`) ?? []) {
      const sx = x(itemCol[slot]);
      const sy = y[slot] + NODE_H / 2;
      path += ` ${curve(cx, cy, sx, sy)} L ${sx + NODE_W} ${sy}`;
      cx = sx + NODE_W;
      cy = sy;
    }
    path += ` ${curve(cx, cy, b.x, b.y + NODE_H / 2)}`;
    return { blocker: e.blocker, ticket: e.ticket, path, done: a.node.state === 'closed', cycle: back.has(`${ai}>${bi}`) };
  });
  return { nodes: placed, edges: placedEdges, width, height: placed.length ? top - BAND_GAP + PAD : 0 };
}

/** The status words under a ticket on the graph, in the Tickets page's order. */
export function nodeStatus(node: DependencyNode): { tone: Tone; text: string } {
  if (node.state === 'closed') return { tone: 'ok', text: 'Closed' };
  const t = node.ticket;
  if (!t) return { tone: 'idle', text: 'Not in Workshop' };
  const status = ticketStatus(t);
  if (status) return status;
  if (t.attention === 'review') return { tone: 'attention', text: 'Waiting for your review' };
  if (node.held && t.next) return { tone: 'attention', text: t.next };
  return { tone: 'idle', text: t.stage ? STAGE_TEXT[t.stage] : 'To classify' };
}

/** Cuts text to `max` characters with an ellipsis. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
