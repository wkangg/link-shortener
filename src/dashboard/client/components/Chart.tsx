import { useEffect, useRef, useSyncExternalStore } from 'react';
import uPlot from 'uplot';

import type { TimeseriesResponse } from '../../../shared/types.ts';
import {
    carryZoom,
    type ChartFrame,
    type ChartSnapshot,
    chartTransition,
    clampZoom,
    type Span,
    yTop
} from '../chartTransition.ts';
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

/** A drag narrower than this (CSS pixels) is a click, not a zoom. */
const MIN_DRAG_PX = 4;

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
 *
 * Dragging across the plot zooms into that span and double-clicking zooms back out,
 * both easing like a change of data. The zoom outlasts refreshes and filter changes
 * while the new data still covers it (see `carryZoom`).
 */
export function Chart({ data, error }: { data: TimeseriesResponse | undefined; error?: Error }) {
    const host = useRef<HTMLDivElement>(null);
    const tooltip = useRef<HTMLDivElement>(null);
    const dark = useDarkScheme();
    const reduce = useReducedMotion();
    // What's on screen now, zoom included, so new data and zooms ease from there.
    const drawn = useRef<ChartSnapshot | null>(null);
    // The span dragged into (null for the whole range), and the data it was fitted to.
    const zoom = useRef<Span | null>(null);
    const zoomedData = useRef<TimeseriesResponse | null>(null);
    // Eases the plot below to new data, in the current zoom.
    const render = useRef<((data: TimeseriesResponse) => void) | null>(null);
    const hasData = data !== undefined;

    // One plot for as long as there's data, so refreshes and filter changes update it in
    // place rather than losing the zoom with it. Rebuilt when its colors or motion change.
    useEffect(() => {
        const el = host.current;
        const tip = tooltip.current;
        if (!el || !tip) return;
        // Nothing drawn (still loading, or the request failed): the next data rises from 0,
        // like the totals, rather than easing from lines that are no longer on screen.
        if (!hasData) {
            drawn.current = null;
            return;
        }

        // The data shown, and its points by bucket start in seconds, as drawn on the x axis.
        let shown: TimeseriesResponse | undefined;
        let points = new Map<number, TimeseriesResponse['points'][number]>();
        let tipFmt = tooltipDay;
        // Read by the scales below, so the view moves with the lines while they ease.
        let frame: ChartFrame = drawn.current ?? { data: [[], [], []], x: [0, 1], top: yTop(0) };
        let stop: (() => void) | undefined;
        const ink = cssVar(el, '--text-secondary');
        const grid = cssVar(el, '--grid');
        const font = `12px ${cssVar(el, '--sans')}`;
        const axis = {
            stroke: ink,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            font
        };

        /** Eases from what's drawn to `next`, in the current zoom. */
        function show(next: TimeseriesResponse) {
            stop?.();
            stop = undefined;
            shown = next;
            points = new Map(next.points.map(p => [p.t / 1000, p]));
            tipFmt = next.interval === 'hour' ? tooltipHour : tooltipDay;
            const transition = chartTransition(drawn.current, next, zoom.current);
            const draw = (k: number) => {
                frame = transition.at(k);
                drawn.current = { ...frame, interval: next.interval };
                plot.setData(frame.data);
            };
            if (reduce || !transition.moves) {
                draw(1);
                return;
            }
            draw(0);
            stop = animate(draw);
        }

        /** Zooms into `span` (null for the whole range), easing like new data. */
        function zoomTo(span: Span | null) {
            if (!shown) return;
            zoom.current = span;
            show(shown);
        }

        const plot = new uPlot(
            {
                width: el.clientWidth,
                height: 240,
                legend: { show: false },
                cursor: {
                    y: false,
                    points: { size: 8 },
                    // uPlot would set the scale at once; the setSelect hook eases it instead.
                    drag: { x: true, y: false, setScale: false },
                    // In place of uPlot's own reset, which would snap back to the whole range.
                    bind: {
                        dblclick: () => () => {
                            zoomTo(null);
                            return null;
                        }
                    }
                },
                scales: {
                    x: { time: true, range: () => frame.x },
                    y: { range: () => [0, frame.top] }
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
                            // Look the point up by time, not index: while the view eases, the
                            // plot also draws buckets that are leaving, which have no tooltip.
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
                    ],
                    setSelect: [
                        u => {
                            const { left, width } = u.select;
                            if (width === 0) return;
                            // The view eases to the span instead, so the selection box goes.
                            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
                            if (width < MIN_DRAG_PX || !shown) return;
                            const span: Span = [
                                u.posToVal(left, 'x'),
                                u.posToVal(left + width, 'x')
                            ];
                            zoomTo(clampZoom(span, shown));
                        }
                    ]
                }
            },
            frame.data,
            el
        );
        render.current = show;

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
            render.current = null;
            observer.disconnect();
            plot.destroy();
            // Or a hover from before a failed refresh stays on screen.
            tip.hidden = true;
        };
    }, [hasData, dark, reduce]);

    // Runs after the effect above, so also right after it rebuilds the plot, which then
    // shows what was drawn before without easing.
    useEffect(() => {
        if (!data) return;
        zoom.current = carryZoom(zoom.current, zoomedData.current, data);
        zoomedData.current = data;
        render.current?.(data);
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
