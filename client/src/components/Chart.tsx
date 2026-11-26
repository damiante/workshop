import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { niceTicks, spreadLabels } from '../chart.ts';
import { clock } from '../format.ts';

const HEIGHT = 200;
const TOP = 10;
const BOTTOM = 24;

/** The element's content width, once measured; 0 until then. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The hovered or tapped item. A mouse leaving the chart clears it; touch fires a leave as soon as the tap ends,
 * so a tapped tooltip stays until you tap outside the chart.
 */
function useActive<T>(ref: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState<T | null>(null);
  useEffect(() => {
    if (active === null) return;
    const outside = (e: globalThis.PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [active, ref]);
  const leave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') setActive(null);
  };
  return [active, setActive, leave] as const;
}

/** A tooltip beside `x`, flipped to the left in the right half so it stays inside the chart. */
function Tip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const style = x > width / 2 ? { right: width - x + 8 } : { left: x + 8 };
  return (
    <div className="chart-tip small" style={style} role="status">
      {children}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string }[] }) {
  return (
    <ul className="legend small">
      {items.map((i) => (
        <li key={i.name}>
          <span className="swatch" style={{ background: i.color }} aria-hidden="true" />
          {i.name}
        </li>
      ))}
    </ul>
  );
}

/** A rectangle from `y` to `y + h` with its top corners rounded by `r`. */
const roundedTop = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;

export interface ColumnSeries {
  name: string;
  color: string;
  values: number[];
}

/** Stacked columns, one per bucket, bottom-up in series order. */
export function StackedColumns({ labels, series, format, label }: { labels: string[]; series: ColumnSeries[]; format: (n: number) => string; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive, leave] = useActive<number>(ref);
  const totals = labels.map((_, i) => series.reduce((n, s) => n + s.values[i], 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1];
  const left = Math.max(...ticks.map((t) => format(t).length)) * 7 + 12;
  const right = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - TOP - BOTTOM;
  const band = labels.length ? plotW / labels.length : 0;
  const colW = Math.max(1, band * 0.75);
  const tight = band < 4;
  const gap = tight ? 0 : 2;
  const y = (v: number) => TOP + plotH - (v / top) * plotH;
  const every = Math.max(1, Math.ceil(56 / Math.max(band, 1)));

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - box.left - left) / band);
    setActive(i >= 0 && i < labels.length ? i : null);
  };

  return (
    <div className="chart" ref={ref} style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label} onPointerMove={pick} onPointerDown={pick} onPointerLeave={leave}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t) + 0.5} y2={y(t) + 0.5} className="chart-grid" />
              <text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">
                {format(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const x = left + i * band + (band - colW) / 2;
            let base = y(0);
            const visible = series.map((s, k) => ({ s, k, v: s.values[i] })).filter((p) => p.v > 0);
            return (
              <g key={l} opacity={active === null || active === i ? 1 : 0.6}>
                {visible.map((p, j) => {
                  const h = base - y(p.v);
                  const isTop = j === visible.length - 1;
                  const drawn = isTop ? h : Math.max(0, h - gap);
                  const segTop = base - h;
                  base -= h;
                  if (drawn <= 0) return null;
                  const r = tight ? 0 : Math.min(4, colW / 2, drawn);
                  return isTop && r > 0 ? (
                    <path key={p.k} d={roundedTop(x, segTop, colW, drawn, r)} style={{ fill: p.s.color }} />
                  ) : (
                    <rect key={p.k} x={x} y={segTop + (h - drawn)} width={colW} height={drawn} style={{ fill: p.s.color }} />
                  );
                })}
              </g>
            );
          })}
          {labels.map((l, i) => {
            if (i % every !== 0) return null;
            const x = left + i * band + band / 2;
            // A label that would run off the right edge is dropped rather than shifted into its neighbour.
            if (x + 24 > width) return null;
            return (
              <text key={l} x={x} y={HEIGHT - 6} textAnchor="middle" className="chart-axis">
                {l}
              </text>
            );
          })}
        </svg>
      )}
      {active !== null && width > 0 && (
        <Tip x={left + active * band + band / 2} width={width}>
          <strong>{labels[active]}</strong>
          {series
            .filter((s) => s.values[active] > 0)
            .map((s) => (
              <div key={s.name} className="tip-row">
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                <span className="grow">{s.name}</span>
                <span>{format(s.values[active])}</span>
              </div>
            ))}
          <div className="tip-row">
            <span className="grow">Total</span>
            <span>{format(totals[active])}</span>
          </div>
        </Tip>
      )}
    </div>
  );
}

export interface LineSeries {
  name: string;
  color: string;
  /** [time, percentage], oldest first. */
  points: [number, number][];
}

/** Readings more than this far apart aren't joined, so idle time doesn't show as a slope. */
const MAX_GAP = 2 * 3600_000;

/** Percentages over time on a fixed 0–100% axis, with dashed reference lines at `marks`. */
export function LineChart({ start, end, series, marks, label }: { start: number; end: number; series: LineSeries[]; marks: { label: string; value: number }[]; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive, leave] = useActive<number>(ref);
  const left = 44;
  const right = 8;
  const plotW = Math.max(0, width - left - right);
  const plotH = HEIGHT - TOP - BOTTOM;
  const x = (t: number) => left + ((t - start) / (end - start)) * plotW;
  const y = (v: number) => TOP + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);

  // Local midnights inside the range, labelled by weekday.
  const days: number[] = [];
  const d = new Date(start);
  d.setHours(24, 0, 0, 0);
  for (; d.getTime() < end; d.setDate(d.getDate() + 1)) days.push(d.getTime());
  const dayW = days.length > 1 ? x(days[1]) - x(days[0]) : plotW;
  const everyDay = Math.max(1, Math.ceil(36 / Math.max(dayW, 1)));

  const markYs = spreadLabels(marks.map((m) => y(m.value) - 4));

  const paths = (points: [number, number][]) => {
    const out: string[] = [];
    let d = '';
    points.forEach(([t, v], i) => {
      const cmd = i === 0 || t - points[i - 1][0] > MAX_GAP ? 'M' : 'L';
      if (cmd === 'M' && d) {
        out.push(d);
        d = '';
      }
      d += `${cmd}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (d) out.push(d);
    return out;
  };

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!times.length) return;
    const box = e.currentTarget.getBoundingClientRect();
    const t = start + ((e.clientX - box.left - left) / plotW) * (end - start);
    setActive(times.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best), times[0]));
  };

  return (
    <div className="chart" ref={ref} style={{ height: HEIGHT }}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label} onPointerMove={pick} onPointerDown={pick} onPointerLeave={leave}>
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t) + 0.5} y2={y(t) + 0.5} className="chart-grid" />
              <text x={left - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">
                {t}%
              </text>
            </g>
          ))}
          {days.map((t, i) =>
            i % everyDay === 0 ? (
              <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor="middle" className="chart-axis">
                {new Date(t).toLocaleDateString([], { weekday: 'short' })}
              </text>
            ) : null,
          )}
          {marks.map((m, i) => (
            <g key={m.label}>
              <line x1={left} x2={width - right} y1={y(m.value) + 0.5} y2={y(m.value) + 0.5} className="chart-mark" />
              <text x={width - right} y={markYs[i]} textAnchor="end" className="chart-axis chart-label">
                {m.label}
              </text>
            </g>
          ))}
          {series.map((s) => paths(s.points).map((d, i) => <path key={`${s.name}-${i}`} d={d} className="chart-line" style={{ stroke: s.color }} />))}
          {series.map((s) =>
            s.points
              .filter((p, i, all) => (i === 0 || p[0] - all[i - 1][0] > MAX_GAP) && (i === all.length - 1 || all[i + 1][0] - p[0] > MAX_GAP))
              .map((p) => <circle key={`${s.name}-${p[0]}`} cx={x(p[0])} cy={y(p[1])} r={2.5} style={{ fill: s.color }} />),
          )}
          {active !== null && (
            <g>
              <line x1={x(active) + 0.5} x2={x(active) + 0.5} y1={TOP} y2={TOP + plotH} className="chart-cross" />
              {series.map((s) => {
                const p = s.points.find((q) => q[0] === active);
                return p ? <circle key={s.name} cx={x(p[0])} cy={y(p[1])} r={4} className="chart-dot" style={{ fill: s.color }} /> : null;
              })}
            </g>
          )}
        </svg>
      )}
      {active !== null && width > 0 && (
        <Tip x={x(active)} width={width}>
          <strong>{clock(active)}</strong>
          {series.map((s) => {
            const p = s.points.find((q) => q[0] === active);
            return p ? (
              <div key={s.name} className="tip-row">
                <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
                <span className="grow">{s.name}</span>
                <span>{Math.round(p[1])}%</span>
              </div>
            ) : null;
          })}
        </Tip>
      )}
    </div>
  );
}
