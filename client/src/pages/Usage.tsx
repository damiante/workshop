import { useSearchParams } from 'react-router';
import type { AllowanceHistory, LifetimeSpend, SpendTotals, UsageHistory, WindowProjection } from '../../../server/src/api-types.ts';
import { bucketLabel, foldSeries, GROUPINGS, METRICS, RANGES, readFilters, value, type Grouping } from '../chart.ts';
import { useApi, useNow } from '../api.ts';
import { Legend, LineChart, StackedColumns } from '../components/Chart.tsx';
import { ErrorNote, Panel } from '../components/ui.tsx';
import { clock, money, tokens } from '../format.ts';

const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
const OTHER_COLOR = 'var(--series-other)';
/** Matches the launch gate: an older reading gets re-checked before a launch. */
const ALLOWANCE_MAX_AGE_MS = 10 * 60_000;
const SEVEN_DAYS = 7 * 86400_000;

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

/** One sentence about where a subscription window is heading. */
function windowLine(name: string, a: AllowanceHistory, p: WindowProjection | null, limit: number, now: number): string {
  if (!p) return `${name}: ${a.sampledAt === null ? 'No current reading.' : 'The window has reset since the last reading.'}`;
  const old = a.sampledAt !== null && now - a.sampledAt > ALLOWANCE_MAX_AGE_MS;
  const head = old ? `${name}, as of ${clock(a.sampledAt!)}:` : `${name}:`;
  const resets = clock(p.resetsAt);
  if (p.over) return `${head} ${Math.round(p.pct)}% used. Over your ${limit}% limit until it resets at ${resets}.`;
  let line = `${head} ${Math.round(p.pct)}% used, ${p.ratePerHour.toFixed(1)}% an hour.`;
  if (p.limitAt === null) line += p.ratePerHour > 0 ? ` Resets at ${resets} before reaching your ${limit}% limit.` : ` Resets at ${resets}.`;
  else if (p.limitAt === a.sampledAt) line += ` At your ${limit}% limit; resets at ${resets}.`;
  else if (p.limitAt <= now) line += ` At that pace it may already be at your ${limit}% limit.`;
  else line += ` Reaches your ${limit}% limit at ${clock(p.limitAt)} and resets at ${resets}.`;
  if (p.fullAt !== null && p.fullAt !== p.limitAt && p.fullAt > now) line += ` Reaches 100% at ${clock(p.fullAt)}.`;
  return line;
}

function subscriptionLines(a: AllowanceHistory, now: number): string[] {
  if (a.blockedUntil) return [`${a.connectionName}: Claude reported a usage limit; resumes at ${clock(a.blockedUntil)}.`];
  if (a.unknown) return [`${a.connectionName}: Claude doesn't report this subscription's usage.`];
  return [
    windowLine(`${a.connectionName}, 5-hour window`, a, a.fiveHour, a.limits.fiveHour, now),
    windowLine(`${a.connectionName}, weekly window`, a, a.sevenDay, a.limits.weekly, now),
  ];
}

function Projections({ data, now }: { data: UsageHistory; now: number }) {
  const { api, subscription } = data.projection;
  const lines = data.allowance.flatMap((a) => subscriptionLines(a, now));
  if (api.monthToDateUsd > 0 || api.todayUsd > 0) {
    const today = `API: ${money(api.todayUsd)} today.`;
    if (api.dailyCapUsd <= 0) lines.push('API agents are off: the daily limit is $0.');
    else if (api.todayUsd >= api.dailyCapUsd) lines.push(`${today} API daily limit reached; new API agents start again tomorrow.`);
    else if (api.capAt !== null) lines.push(`${today} At today's pace new API agents stop starting at about ${clock(api.capAt)}, when the ${money(api.dailyCapUsd)} daily limit is reached.`);
    else lines.push(`${today} At today's pace it stays under the ${money(api.dailyCapUsd)} daily limit today.`);
    lines.push(`API this month: ${money(api.monthToDateUsd)} so far, about ${money(api.monthEndUsd)} by the end of the month at ${money(api.perDayUsd)} a day (last 7 days).`);
  }
  if (data.allowance.length > 0 || subscription.monthToDateUsd > 0) {
    lines.push(
      `Subscriptions this month: ${money(subscription.monthToDateUsd)} token-equivalent so far, about ${money(subscription.monthEndUsd)} by the end of the month (${tokens(Math.round(subscription.perDayTokens))} a day).`,
    );
  }
  return (
    <Panel title="Projections">
      <div className="panel-body stack">
        {lines.length === 0 ? (
          <p className="small muted">Nothing to project yet: no subscriptions and no API spend this month.</p>
        ) : (
          <ul className="projections">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        <p className="small muted">Projections assume the same pace continues. Workshop stops starting agents at your limits, so real use levels off there.</p>
      </div>
    </Panel>
  );
}

function SpendOverTime({ data, group, metric }: { data: UsageHistory; group: Grouping; metric: 'cost' | 'tokens' }) {
  const all = data[SERIES_OF[group]];
  const folded = foldSeries(all, metric);
  const series = folded.map((s, i) => ({ name: s.name, color: s.key === 'other' ? OTHER_COLOR : SERIES_COLORS[i], values: s.points.map((p) => value(p, metric)) }));
  const format = metric === 'cost' ? (n: number) => money(n)! : (n: number) => tokens(n)!.replace(' tokens', '');
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
              label={`${metric === 'cost' ? 'Cost' : 'Tokens'} per ${unit} by ${groupLabel.toLowerCase()}, ${metric === 'cost' ? money(total) : tokens(total)} in total.`}
            />
            <SpendTable title={`By ${groupLabel.toLowerCase()}`} label={group} rows={rows.map((s) => ({ key: s.key, name: s.name, t: s.totals }))} />
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
          {data.allowance.length > 0 && <SubscriptionUsage allowance={data.allowance} now={now} />}
        </>
      )}
      <LifetimeUsage />
    </div>
  );
}
