import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { DependencyGraph } from '../../../server/src/api-types.ts';
import { useApi } from '../api.ts';
import { ErrorNote } from '../components/ui.tsx';
import { clip, layoutGraph, NODE_H, NODE_W, nodeStatus, type PlacedNode } from '../graph.ts';

function Node({ p }: { p: PlacedNode }) {
  const navigate = useNavigate();
  const { node } = p;
  const status = nodeStatus(node, p.blocked);
  const title = node.title ?? 'Untitled';
  const label = `${node.ref} ${title}, ${status.text}`;
  const body = (
    <>
      <title>{`${node.ref} ${title}`}</title>
      <rect className="graph-box" width={NODE_W} height={NODE_H} rx={6} />
      <text className="graph-ref" x={12} y={19}>
        {node.ref}
      </text>
      <text className="graph-title" x={12} y={37}>
        {clip(title, 30)}
      </text>
      <circle className={`graph-dot ${status.tone}`} cx={16} cy={51} r={4} />
      <text className="graph-status" x={26} y={55}>
        {clip(status.text, 32)}
      </text>
    </>
  );
  const className = `graph-node${node.state === 'closed' ? ' closed' : ''}`;
  const transform = `translate(${p.x} ${p.y})`;
  if (node.ticket) {
    const to = `/tickets/${node.ticket.id}`;
    return (
      <g transform={transform}>
        <a
          className={className}
          href={to}
          aria-label={label}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            navigate(to);
          }}
        >
          {body}
        </a>
      </g>
    );
  }
  return (
    <g transform={transform}>
      <a className={className} href={node.url} target="_blank" rel="noopener noreferrer" aria-label={`${label}, opens GitHub`}>
        {body}
      </a>
    </g>
  );
}

export function Dependencies() {
  const { data, error } = useApi<DependencyGraph[]>('/dependencies', ['tickets', 'runs']);
  const [params, setParams] = useSearchParams();
  const [hideClosed, setHideClosed] = useState(false);
  const wanted = Number(params.get('repo'));
  // An unknown or disabled repo falls back to the first one with links, so an old link still shows something.
  const graph = data?.find((g) => g.repoId === wanted) ?? data?.find((g) => g.edges.length) ?? data?.[0];
  const layout = graph ? layoutGraph(graph, { hideClosed }) : null;
  const closed = graph?.nodes.filter((n) => n.state === 'closed').length ?? 0;
  const total = graph?.nodes.length ?? 0;

  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          <h1>Dependencies</h1>
          <Link to="/tickets">Tickets</Link>
        </div>
        {data && data.length > 0 && (
          <div className="row">
            <select value={graph?.repoId ?? ''} onChange={(e) => setParams({ repo: e.target.value })} style={{ width: 'auto' }} aria-label="Repository">
              {data.map((g) => (
                <option key={g.repoId} value={g.repoId}>
                  {g.repo}
                </option>
              ))}
            </select>
            <label className="row small">
              <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} />
              <span>Hide closed tickets</span>
            </label>
          </div>
        )}
      </div>
      <ErrorNote error={error} />
      {data && !data.length && (
        <p className="notice">
          No enabled repositories yet. Enable one under <Link to="/connections">Connections</Link>.
        </p>
      )}
      {graph && !graph.edges.length && (
        <p className="notice">
          No tickets in {graph.repo} depend on others. Links you add on GitHub with “Blocked by” show up here after the next sync.
        </p>
      )}
      {graph && layout && graph.edges.length > 0 && (
        <>
          <p className="muted small">
            {closed} of {total} {total === 1 ? 'ticket in this tree is' : 'tickets in these trees are'} closed. Blockers sit on the left of the tickets that wait for them.
          </p>
          {layout.nodes.length ? (
            <div className="graph-wrap">
              <svg role="group" aria-label={`Dependencies in ${graph.repo}`} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
                <defs>
                  <marker id="graph-arrow" viewBox="0 0 8 8" refX={8} refY={4} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
                    <path d="M 0 0 L 8 4 L 0 8 z" className="graph-arrow" />
                  </marker>
                  <marker id="graph-arrow-done" viewBox="0 0 8 8" refX={8} refY={4} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
                    <path d="M 0 0 L 8 4 L 0 8 z" className="graph-arrow done" />
                  </marker>
                </defs>
                {layout.edges.map((e) => (
                  <path
                    key={`${e.blocker}>${e.ticket}`}
                    className={`graph-edge${e.done ? ' done' : ''}`}
                    d={e.path}
                    markerEnd={`url(#graph-arrow${e.done ? '-done' : ''})`}
                  />
                ))}
                {layout.nodes.map((p) => (
                  <Node key={p.node.ref} p={p} />
                ))}
              </svg>
            </div>
          ) : (
            <p className="notice">Every ticket in these trees is closed. Clear Hide closed tickets to see them.</p>
          )}
        </>
      )}
    </div>
  );
}
