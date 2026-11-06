import { useEffect, useRef, useSyncExternalStore } from 'react';
import uPlot from 'uplot';

import type { TimeseriesResponse } from '../../../shared/types.ts';
import { type ChartSnapshot, chartTransition, yTop } from '../chartTransition.ts';
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

/** The longest span charted in hours (the server's cutoff), in seconds. */
const HOURLY_SPAN_S = 3 * 86_400;

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

/**
 * Clicks and unique visitors over time, with a crosshair tooltip. Empty until `data`
 * arrives, so the card holds its place while the first request loads, or says why
 * when the request fails.
 */
export function Chart({ data, error }: { data: TimeseriesResponse | undefined; error?: Error }) {
    const host = useRef<HTMLDivElement>(null);
    const tooltip = useRef<HTMLDivElement>(null);
    const dark = useDarkScheme();
    const reduce = useReducedMotion();
    // What's on screen now, so new data eases from there.
    const drawn = useRef<ChartSnapshot | null>(null);

    useEffect(() => {
        const el = host.current;
        const tip = tooltip.current;
        if (!el || !tip) return;
        // Nothing drawn (still loading, or the request failed): the next data rises from 0,
        // like the totals, rather than easing from lines that are no longer on screen.
        if (!data) {
            drawn.current = null;
            return;
        }

        // By bucket start in seconds, as drawn on the x axis.
        const points = new Map(data.points.map(p => [p.t / 1000, p]));
        const transition = chartTransition(drawn.current, data);
        let progress = reduce || !transition.moves ? 1 : 0;
        // Read by the scales below, so the view moves with the lines while they ease.
        let frame = transition.at(progress);
        const ink = cssVar(el, '--text-secondary');
        const grid = cssVar(el, '--grid');
        const font = `12px ${cssVar(el, '--sans')}`;
        const axis = {
            stroke: ink,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            font
        };
        const tipFmt = data.interval === 'hour' ? tooltipHour : tooltipDay;

        const plot = new uPlot(
            {
                width: el.clientWidth,
                height: 240,
                legend: { show: false },
                cursor: { y: false, points: { size: 8 } },
                scales: {
                    x: {
                        time: true,
                        range: (_u, min, max) => (progress < 1 ? frame.x : [min, max])
                    },
                    y: {
                        range: (_u, _min, max) => [0, progress < 1 ? frame.top : yTop(max)]
                    }
                },
                axes: [
                    {
                        ...axis,
                        grid: { show: false },
                        // By the span in view rather than the bucket size, so labels suit the
                        // view while it zooms between hours and days.
                        values: (u, ticks) => {
                            const span = (u.scales.x?.max ?? 0) - (u.scales.x?.min ?? 0);
                            const fmt = span <= HOURLY_SPAN_S ? hourFmt : dayFmt;
                            return ticks.map(t => fmt.format(t * 1000));
                        }
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
                            // No tooltip while the lines ease: it would show the final counts
                            // beside a line that's still on its way there.
                            if (progress < 1) {
                                tip.hidden = true;
                                return;
                            }
                            // Look the point up by time rather than index, which also holds
                            // while the plot draws buckets that are leaving.
                            const i = u.cursor.idx;
                            const x = i === null || i === undefined ? undefined : u.data[0][i];
                            const point = x === undefined ? undefined : points.get(x);
                            if (x === undefined || !point) {
                                tip.hidden = true;
                                return;
                            }
                            tip.hidden = false;
                            tip.replaceChildren(
                                Object.assign(document.createElement('strong'), {
                                    textContent: tipFmt.format(point.t)
                                }),
                                Object.assign(document.createElement('span'), {
                                    textContent: `${point.clicks} clicks, ${point.visitors} unique`
                                })
                            );
                            const left = u.valToPos(x, 'x');
                            tip.style.transform = `translateX(${Math.min(left, el.clientWidth - 180)}px)`;
                        }
                    ]
                }
            },
            frame.data,
            el
        );

        const stop =
            progress < 1
                ? animate(k => {
                      progress = k;
                      frame = transition.at(k);
                      plot.setData(frame.data);
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
            drawn.current = { ...frame, interval: data.interval };
            observer.disconnect();
            plot.destroy();
            // Or a hover from before a failed refresh stays on screen.
            tip.hidden = true;
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
                {!data && error && (
                    <p className="chart-empty">Couldn’t load the chart: {error.message}</p>
                )}
            </div>
        </figure>
    );
}
