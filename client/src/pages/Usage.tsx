import { useSearchParams } from 'react-router';
import type { AllowanceHistory, LifetimeSpend, SpendTotals, UsageHistory } from '../../../server/src/api-types.ts';
import { bucketLabel, foldSeries, GROUPINGS, METRICS, RANGES, readFilters, shares, value, type Grouping, type Metric } from '../chart.ts';
import { useApi, useNow } from '../api.ts';
import { Bars, Legend, LineChart, StackedColumns } from '../components/Chart.tsx';
import { ErrorNote, Panel } from '../components/ui.tsx';
import { money, tokens } from '../format.ts';
import { projectionSections, type Cell } from '../projections.ts';

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const OTHER_COLOR = 'var(--series-other)';
const SEVEN_DAYS = 7 * 86400_000;
/** Projects that get a chart of their own on the Usage page; the bars rank them all. */
const PROJECT_CHARTS = 6;

const SERIES_OF: Record<Grouping, keyof Pick<UsageHistory, 'byBilling' | 'byModel' | 'byProject' | 'byConnection'>> = {
  billing: 'byBilling',
  model: 'byModel',
  project: 'byProject',
  connection: 'byConnection',
};

export function SpendTable({ title, label, rows }: { title: string; label: string; rows: { key: string; name: string; t: SpendTotals }[] }) {
  return (
    <div className="table-wrap">
      <table className="spend-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">Runs</th>
            <th className="num">Input</th>
            <th className="num">Output</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${label}-${r.key}`}>
              <td>{r.name}</td>
              <td className="num">{r.t.runs}</td>
              <td className="num">{tokens(r.t.inputTokens)}</td>
              <td className="num">{tokens(r.t.outputTokens)}</td>
              <td className="num">{money(r.t.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LifetimeUsage() {
  const { data, error } = useApi<LifetimeSpend>('/usage/lifetime', ['runs']);
  return (
    <Panel title="Lifetime usage">
      <div className="panel-body stack">
        <ErrorNote error={error} />
        {data && data.since === null && <p className="small muted">No agent runs recorded yet.</p>}
        {data && data.since !== null && (
          <>
            <p className="small muted">
              Tokens and token-equivalent cost of every agent run Workshop has recorded since {new Date(data.since).toLocaleDateString()}. On a subscription this is what the same use would
              cost on the API, not what you paid. Claude Code you use outside Workshop isn't counted.
            </p>
            <p>
              {money(data.total.costUsd)} · {tokens(data.total.inputTokens)} in · {tokens(data.total.outputTokens)} out · {data.total.runs} runs
            </p>
            <SpendTable
              title="By billing"
              label="billing"
              rows={[
                { key: 'subscription', name: 'Subscription', t: data.subscription },
                { key: 'api', name: 'API', t: data.api },
              ]}
            />
            <SpendTable title="By model" label="model" rows={data.byModel.map((m) => ({ key: m.model, name: m.model, t: m }))} />
            <SpendTable title="By project" label="project" rows={data.byProject.map((p) => ({ key: p.project ?? '', name: p.project ?? 'Unknown', t: p }))} />
            {data.byProject.some((p) => p.project === null) && (
              <p className="small muted">Unknown is spend from runs deleted before Workshop recorded their repository.</p>
            )}
            <SpendTable
              title="By connection"
              label="connection"
              rows={data.byConnection.map((c) => ({
                key: `${c.connectionId}:${c.billing}`,
                name: `${c.connection ?? 'Unknown'} (${c.billing === 'api' ? 'API key' : 'subscription'})`,
                t: c,
              }))}
            />
            {data.byConnection.some((c) => c.connection === null) && <p className="small muted">Unknown is spend recorded before Workshop kept track of connections.</p>}
            <SpendTable title="By month" label="month" rows={data.byMonth.map((m) => ({ key: m.month, name: m.month, t: m }))} />
          </>
        )}
      </div>
    </Panel>
  );
}

/** Cost with tokens on a second line. */
function CellText({ cell }: { cell: Cell }) {
  return (
    <>
      {cell.cost}
      <span className="cell-sub small muted">{cell.tokens}</span>
    </>
  );
}

/** Only worth a chart when the work takes long enough to show where limits hold it back. */
const BURN_DOWN_MIN_SPAN = 2 * 3600_000;

function BurnDown({ data, now }: { data: UsageHistory; now: number }) {
  const { subscription, api } = data.projection.backlog;
  const pools = [
    { name: 'Subscriptions', color: SERIES_COLORS[0], pool: subscription },
    { name: 'API', color: SERIES_COLORS[1], pool: api },
  ].filter((p) => p.pool && p.pool.curve.length > 1);
  const span = (curve: [number, number][]) => curve[curve.length - 1][0] - curve[0][0];
  if (!pools.some((p) => span(p.pool!.curve) > BURN_DOWN_MIN_SPAN)) return null;
  const series = pools.map((p) => ({ name: p.name, color: p.color, points: p.pool!.curve.map(([t, v]): [number, number] => [t, v * 100]) }));
  const end = Math.max(...pools.map((p) => p.pool!.finishAt ?? p.pool!.curve[p.pool!.curve.length - 1][0]));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {series.length > 1 && <Legend items={series} />}
      <LineChart start={now} end={end} series={series} marks={[]} label="Share of backlog left until it's done" />
    </div>
  );
}

function Projections({ data, now }: { data: UsageHistory; now: number }) {
  const { backlog, burn, windows, month } = projectionSections(data, now);
  const empty = !backlog && burn.length === 0 && windows.length === 0 && month.length === 0;
  return (
    <Panel title="Projections">
      <div className="panel-body stack projections-section">
        {empty && <p className="small muted">Nothing to project yet: no subscriptions and no API spend this month.</p>}
        {backlog && (
          <>
            <h3>Backlog</h3>
            <p>{backlog.lead}</p>
            {backlog.rows.length > 0 && (
              <div className="table-wrap">
                <table className="spend-table">
                  <thead>
                    <tr>
                      <th>Billing</th>
                      <th className="num">Left</th>
                      <th className="num">Pace</th>
                      <th className="num">Finishes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backlog.rows.map((r) => (
                      <tr key={r.key}>
                        <td>{r.billing}</td>
                        <td className="num">
                          <CellText cell={r.left} />
                        </td>
                        <td className="num">{r.pace}</td>
                        <td className="num">{r.finishes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {backlog.notes.length > 0 && (
              <ul className="projections">
                {backlog.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            <BurnDown data={data} now={now} />
            {backlog.detail && <p className="small muted">{backlog.detail}</p>}
          </>
        )}
        {burn.length > 0 && (
          <>
            <h3>Burn rate</h3>
            <div className="table-wrap">
              <table className="spend-table">
                <thead>
                  <tr>
                    <th>Connection</th>
                    <th className="num">Last 5 hours</th>
                    <th className="num">Last 24 hours</th>
                    <th className="num">A day (last 7 days)</th>
                  </tr>
                </thead>
                <tbody>
                  {burn.map((r) => (
                    <tr key={r.key}>
                      <td>{r.name}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} className="num">
                          <CellText cell={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {windows.length > 0 && (
          <>
            <h3>Subscription windows</h3>
            <ul className="projections">
              {windows.map((l) => (
                <li key={l.key}>{l.text}</li>
              ))}
            </ul>
          </>
        )}
        {month.length > 0 && (
          <>
            <h3>This month</h3>
            <ul className="projections">
              {month.map((l) => (
                <li key={l.key}>{l.text}</li>
              ))}
            </ul>
          </>
        )}
        <p className="small muted">
          Projections assume the same pace continues. Workshop stops starting agents at your limits, so real use levels off there. Backlog estimates use what finished tickets of the same size spent on
          the stages left.
        </p>
      </div>
    </Panel>
  );
}

const formatter = (metric: Metric) => (metric === 'cost' ? (n: number) => money(n)! : (n: number) => tokens(n)!.replace(' tokens', ''));

function SpendOverTime({ data, group, metric }: { data: UsageHistory; group: Grouping; metric: Metric }) {
  const all = data[SERIES_OF[group]];
  const folded = foldSeries(all, metric);
  const series = folded.map((s, i) => ({ name: s.name, key: s.key, color: SERIES_COLORS[i] ?? OTHER_COLOR, values: s.points.map((p) => value(p, metric)) }));
  const format = formatter(metric);
  const unit = data.bucket === 'day' ? 'day' : 'month';
  const groupLabel = GROUPINGS.find((g) => g.value === group)!.label;
  const total = folded.reduce((n, s) => n + value(s.totals, metric), 0);
  const rows = all.filter((s) => value(s.totals, metric) > 0);
  if (metric === 'tokens') rows.sort((a, b) => value(b.totals, metric) - value(a.totals, metric));
  return (
    <Panel title="Spend over time">
      <div className="panel-body stack">
        {folded.length === 0 ? (
          <p className="small muted">No agent runs in this range.</p>
        ) : (
          <>
            <p className="small muted">
              {metric === 'cost' ? 'Token-equivalent cost' : 'Tokens (input including cache, plus output)'} per {unit}, by {groupLabel.toLowerCase()}. On a subscription, cost is what the same use
              would cost on the API.
            </p>
            {series.length > 1 && <Legend items={series} />}
            <StackedColumns
              labels={data.buckets.map((b) => bucketLabel(b, data.bucket))}
              series={series}
              format={format}
              minStep={metric === 'cost' ? 0.01 : 1}
              label={`${metric === 'cost' ? 'Cost' : 'Tokens'} per ${unit} by ${groupLabel.toLowerCase()}, ${metric === 'cost' ? money(total) : tokens(total)} in total.`}
            />
            <SpendTable title={`By ${groupLabel.toLowerCase()}`} label={group} rows={rows.map((s) => ({ key: s.key, name: s.name, t: s.totals }))} />
          </>
        )}
      </div>
    </Panel>
  );
}

/** Every project's share of the range, then the biggest few over time on one shared scale so their heights compare. */
function ProjectUsage({ data, metric }: { data: UsageHistory; metric: Metric }) {
  const ranked = shares(data.byProject, metric);
  const format = formatter(metric);
  const unit = data.bucket === 'day' ? 'day' : 'month';
  const what = metric === 'cost' ? 'cost' : 'tokens';
  const charted = ranked.slice(0, PROJECT_CHARTS).map((r) => data.byProject.find((p) => p.key === r.key)!);
  const max = Math.max(0, ...charted.flatMap((p) => p.points.map((t) => value(t, metric))));
  const labels = data.buckets.map((b) => bucketLabel(b, data.bucket));
  return (
    <Panel title="Usage by project">
      <div className="panel-body stack">
        {ranked.length === 0 ? (
          <p className="small muted">No agent runs in this range.</p>
        ) : (
          <>
            <p className="small muted">Each project's share of the {metric === 'cost' ? 'token-equivalent cost' : 'tokens'} in this range.</p>
            <Bars rows={ranked} format={format} label={`Share of ${what} by project in this range.`} />
            <p className="small muted">
              {ranked.length > PROJECT_CHARTS ? `The ${PROJECT_CHARTS} biggest projects` : ranked.length === 1 ? 'The project' : 'Each project'} per {unit}, all on the same scale.
            </p>
            <div className="project-charts">
              {charted.map((p) => (
                <div key={p.key} className="stack" style={{ gap: 4 }}>
                  <h3 className="small" title={p.name}>
                    {p.name}
                  </h3>
                  <StackedColumns
                    labels={labels}
                    series={[{ key: p.key, name: p.name, color: SERIES_COLORS[0], values: p.points.map((t) => value(t, metric)) }]}
                    format={format}
                    minStep={metric === 'cost' ? 0.01 : 1}
                    max={max}
                    height={140}
                    label={`${p.name}: ${what} per ${unit}, ${format(value(p.totals, metric))} in total.`}
                  />
                </div>
              ))}
            </div>
            {data.byProject.some((p) => p.key === '') && <p className="small muted">Unknown is spend from runs deleted before Workshop recorded their repository.</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function SubscriptionUsage({ allowance, now }: { allowance: AllowanceHistory[]; now: number }) {
  return (
    <Panel title="Subscription usage">
      <div className="panel-body stack">
        <p className="small muted">5-hour and weekly usage over the last 7 days, as Workshop read it. Gaps are times nothing was read. Dashed lines are your limits.</p>
        {allowance.map((a) => {
          const five = a.samples.flatMap((s): [number, number][] => (s.fiveHour === null ? [] : [[s.ts, s.fiveHour]]));
          const week = a.samples.flatMap((s): [number, number][] => (s.sevenDay === null ? [] : [[s.ts, s.sevenDay]]));
          const series = [
            { name: '5-hour', color: SERIES_COLORS[0], points: five },
            { name: 'Weekly', color: SERIES_COLORS[1], points: week },
          ];
          return (
            <div key={a.connectionId} className="stack" style={{ gap: 8 }}>
              <h3>{a.connectionName}</h3>
              {five.length + week.length === 0 ? (
                <p className="small muted">No readings in the last 7 days.</p>
              ) : (
                <>
                  <Legend items={series} />
                  <LineChart
                    start={now - SEVEN_DAYS}
                    end={now}
                    series={series}
                    marks={[
                      { label: `5-hour limit ${a.limits.fiveHour}%`, value: a.limits.fiveHour },
                      { label: `Weekly limit ${a.limits.weekly}%`, value: a.limits.weekly },
                    ]}
                    label={`${a.connectionName}: 5-hour and weekly usage over the last 7 days, with limits at ${a.limits.fiveHour}% and ${a.limits.weekly}%.`}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function Usage() {
  const [params, setParams] = useSearchParams();
  const { range, group, metric } = readFilters(params);
  const { data, error } = useApi<UsageHistory>(`/usage/history?range=${range}`, ['runs', 'allowance', 'settings']);
  const now = useNow();
  const set = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(key, v);
    setParams(next, { replace: true });
  };
  return (
    <div className="stack">
      <h1>Usage</h1>
      <div className="filters">
        <label className="field">
          <span>Range</span>
          <select value={range} onChange={(e) => set('range', e.target.value)}>
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Group by</span>
          <select value={group} onChange={(e) => set('group', e.target.value)}>
            {GROUPINGS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Show</span>
          <select value={metric} onChange={(e) => set('show', e.target.value)}>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorNote error={error} />
      {data && (
        <>
          <Projections data={data} now={now} />
          <SpendOverTime data={data} group={group} metric={metric} />
          <ProjectUsage data={data} metric={metric} />
          {data.allowance.length > 0 && <SubscriptionUsage allowance={data.allowance} now={now} />}
        </>
      )}
      <LifetimeUsage />
    </div>
  );
}
