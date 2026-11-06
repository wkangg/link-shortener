import { useEffect, useRef } from 'react';
import uPlot from 'uplot';

import type { TimeseriesResponse } from '../../../shared/types.ts';

const SERIES = [
    { label: 'Clicks', css: '--series-1' },
    { label: 'Unique visitors', css: '--series-2' }
] as const;

function cssVar(el: Element, name: string): string {
    return getComputedStyle(el).getPropertyValue(name).trim();
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

/** Clicks and unique visitors over time, with a crosshair tooltip. */
export function Chart({ data }: { data: TimeseriesResponse }) {
    const host = useRef<HTMLDivElement>(null);
    const tooltip = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = host.current;
        const tip = tooltip.current;
        if (!el || !tip) return;

        const xs = data.points.map(p => p.t / 1000);
        const plotData: uPlot.AlignedData = [
            xs,
            data.points.map(p => p.clicks),
            data.points.map(p => p.visitors)
        ];
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
                    y: { range: (_u, _min, max) => [0, Math.max(4, max * 1.1)] }
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
            plotData,
            el
        );

        const observer = new ResizeObserver(() =>
            plot.setSize({ width: el.clientWidth, height: 240 })
        );
        observer.observe(el);

        // Canvas text neither loads web fonts nor repaints when one arrives, so the axis
        // labels keep the fallback font if the chart draws first. Redraw once it's loaded.
        let alive = true;
        void document.fonts.load(font).then(() => {
            if (alive) plot.redraw(false, true);
        });

        return () => {
            alive = false;
            observer.disconnect();
            plot.destroy();
        };
    }, [data]);

    const empty = !data.points.some(p => p.clicks > 0);

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
