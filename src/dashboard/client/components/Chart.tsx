import { useEffect, useRef, useSyncExternalStore } from 'react';
import uPlot from 'uplot';

import type { TimeseriesResponse } from '../../../shared/types.ts';
import { animate, useReducedMotion } from '../motion.ts';

const SERIES = [
    { label: 'Clicks', css: '--series-1' },
    { label: 'Unique visitors', css: '--series-2' }
] as const;

function cssVar(el: Element, name: string): string {
    return getComputedStyle(el).getPropertyValue(name).trim();
}

// The canvas reads its colors from CSS once, so it's rebuilt when the color scheme flips.
// matchMedia is called lazily so importing this module without a DOM (tests) doesn't throw.
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');

function subscribeToScheme(onChange: () => void): () => void {
    const query = darkQuery();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

function useDarkScheme(): boolean {
    return useSyncExternalStore(subscribeToScheme, () => darkQuery().matches);
}

const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const tooltipHour = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric'
});
const tooltipDay = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
});

/** Each value `k` of the way from `from` to `to`. */
const lerp = (from: number[], to: number[], k: number) =>
    to.map((v, i) => (from[i] ?? 0) + (v - (from[i] ?? 0)) * k);

/** Clicks and unique visitors per bucket, keyed by bucket start (unix ms). */
interface Drawn {
    interval: TimeseriesResponse['interval'];
    points: Map<number, readonly [clicks: number, visitors: number]>;
}

/**
 * Clicks and unique visitors over time, with a crosshair tooltip. Empty until `data`
 * arrives, so the card holds its place while the first request loads.
 */
export function Chart({ data }: { data: TimeseriesResponse | undefined }) {
    const host = useRef<HTMLDivElement>(null);
    const tooltip = useRef<HTMLDivElement>(null);
    const dark = useDarkScheme();
    const reduce = useReducedMotion();
    // What the lines show now, so new data eases from there. Buckets that weren't
    // drawn before (the first load, a longer date range, hours after days) rise from 0.
    const drawn = useRef<Drawn | null>(null);

    useEffect(() => {
        const el = host.current;
        const tip = tooltip.current;
        if (!el || !tip || !data) return;

        const xs = data.points.map(p => p.t / 1000);
        const clicks = data.points.map(p => p.clicks);
        const visitors = data.points.map(p => p.visitors);
        // An hour and a day can start at the same time, so only like buckets carry over.
        const before = drawn.current?.interval === data.interval ? drawn.current.points : null;
        const fromClicks = data.points.map(p => before?.get(p.t)?.[0] ?? 0);
        const fromVisitors = data.points.map(p => before?.get(p.t)?.[1] ?? 0);
        const linesAt = (k: number) =>
            [lerp(fromClicks, clicks, k), lerp(fromVisitors, visitors, k)] as const;
        const moves = clicks.some((v, i) => v !== fromClicks[i] || visitors[i] !== fromVisitors[i]);
        let progress = reduce || !moves ? 1 : 0;
        // While the lines ease, the y axis already fits the final data instead of following them.
        const top = Math.max(0, ...clicks, ...visitors);
        const ink = cssVar(el, '--text-secondary');
        const grid = cssVar(el, '--grid');
        const font = `12px ${cssVar(el, '--sans')}`;
        const axis = {
            stroke: ink,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            font
        };
        const tickFmt = data.interval === 'hour' ? hourFmt : dayFmt;
        const tipFmt = data.interval === 'hour' ? tooltipHour : tooltipDay;

        const plot = new uPlot(
            {
                width: el.clientWidth,
                height: 240,
                legend: { show: false },
                cursor: { y: false, points: { size: 8 } },
                scales: {
                    x: { time: true },
                    y: {
                        range: (_u, _min, max) => [0, Math.max(4, (progress < 1 ? top : max) * 1.1)]
                    }
                },
                axes: [
                    {
                        ...axis,
                        grid: { show: false },
                        values: (_u, ticks) => ticks.map(t => tickFmt.format(t * 1000))
                    },
                    {
                        ...axis,
                        size: 44,
                        values: (_u, ticks) =>
                            ticks.map(t => (Number.isInteger(t) ? String(t) : ''))
                    }
                ],
                series: [
                    {},
                    ...SERIES.map(s => ({
                        label: s.label,
                        stroke: cssVar(el, s.css),
                        width: 2,
                        points: { show: false }
                    }))
                ],
                hooks: {
                    setCursor: [
                        u => {
                            const i = u.cursor.idx;
                            if (i === null || i === undefined) {
                                tip.hidden = true;
                                return;
                            }
                            const point = data.points[i];
                            if (!point) return;
                            tip.hidden = false;
                            tip.replaceChildren(
                                Object.assign(document.createElement('strong'), {
                                    textContent: tipFmt.format(point.t)
                                }),
                                Object.assign(document.createElement('span'), {
                                    textContent: `${point.clicks} clicks, ${point.visitors} unique`
                                })
                            );
                            const left = u.valToPos(xs[i] ?? 0, 'x');
                            tip.style.transform = `translateX(${Math.min(left, el.clientWidth - 180)}px)`;
                        }
                    ]
                }
            },
            [xs, ...linesAt(progress)],
            el
        );

        // Eases the lines from where they were to the new data.
        const stop =
            progress < 1
                ? animate(k => {
                      progress = k;
                      plot.setData([xs, ...linesAt(k)]);
                  })
                : undefined;

        const observer = new ResizeObserver(() =>
            plot.setSize({ width: el.clientWidth, height: 240 })
        );
        observer.observe(el);

        // Canvas text neither loads web fonts nor repaints when one arrives, so the axis
        // labels keep the fallback font if the chart draws first. Redraw once it's loaded.
        let alive = true;
        void document.fonts.load(font).then(
            () => {
                if (alive) plot.redraw(false, true);
            },
            () => {} // Font failed to load: the fallback already drawn is fine.
        );

        return () => {
            alive = false;
            stop?.();
            const [c, u] = linesAt(progress);
            drawn.current = {
                interval: data.interval,
                points: new Map(data.points.map((p, i) => [p.t, [c[i] ?? 0, u[i] ?? 0]]))
            };
            observer.disconnect();
            plot.destroy();
        };
    }, [data, dark, reduce]);

    const empty = data !== undefined && !data.points.some(p => p.clicks > 0);

    return (
        <figure className="chart">
            <figcaption className="chart-legend">
                {SERIES.map(s => (
                    <span key={s.label} className="legend-item">
                        <span className="legend-swatch" style={{ background: `var(${s.css})` }} />
                        {s.label}
                    </span>
                ))}
            </figcaption>
            <div className="chart-plot">
                <div ref={host} />
                <div ref={tooltip} className="chart-tooltip" hidden />
                {empty && <p className="chart-empty">No clicks in this period</p>}
            </div>
        </figure>
    );
}
