import type { TimeseriesResponse } from '../../shared/types.ts';

/** What the chart shows at one moment: its lines and the view around them. */
export interface ChartFrame {
    /** Bucket starts (unix seconds), then clicks and unique visitors per bucket. */
    data: [xs: number[], clicks: number[], visitors: number[]];
    /** The visible time span (unix seconds). */
    x: [min: number, max: number];
    /** The top of the y axis. */
    top: number;
}

/** A chart frame plus which bucket size its lines are in, so the next data can ease from it. */
export interface ChartSnapshot extends ChartFrame {
    interval: TimeseriesResponse['interval'];
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** The y axis's top for lines peaking at `max`: some headroom, and never so low it's all 0s. */
export const yTop = (max: number) => Math.max(4, max * 1.1);

/**
 * Frames from what was on screen (`before`) to `data`, for progress `k` from 0 to 1.
 *
 * With the same bucket size, the view pans and zooms from the old time span and y axis
 * to the new ones, like a camera: buckets in both ease to their new values, buckets
 * that are leaving stay put as they move out of view, and buckets coming into view
 * appear at their values. With nothing before, or hours after days (an hour and a day
 * can start at the same time, but their counts don't compare), the lines rise from 0
 * in the final view.
 */
export function chartTransition(
    before: ChartSnapshot | null,
    data: TimeseriesResponse
): { at: (k: number) => ChartFrame; moves: boolean } {
    const xs = data.points.map(p => p.t / 1000);
    const clicks = data.points.map(p => p.clicks);
    const visitors = data.points.map(p => p.visitors);
    const final: ChartFrame = {
        data: [xs, clicks, visitors],
        x: [xs[0] ?? 0, xs.at(-1) ?? 0],
        top: yTop(Math.max(0, ...clicks, ...visitors))
    };

    const prev = before?.interval === data.interval ? before : null;
    const start = prev ?? { ...final, data: [xs, xs.map(() => 0), xs.map(() => 0)] };
    const [prevXs, prevClicks, prevVisitors] = start.data;
    const old = new Map(prevXs.map((x, i) => [x, [prevClicks[i] ?? 0, prevVisitors[i] ?? 0]]));
    const next = new Map(xs.map((x, i) => [x, [clicks[i] ?? 0, visitors[i] ?? 0]]));
    const union = [...new Set([...prevXs, ...xs])].toSorted((a, b) => a - b);
    const from = union.map(x => old.get(x) ?? next.get(x) ?? [0, 0]);
    const to = union.map(x => next.get(x) ?? old.get(x) ?? [0, 0]);

    const moves =
        start.top !== final.top ||
        start.x[0] !== final.x[0] ||
        start.x[1] !== final.x[1] ||
        union.length !== xs.length ||
        from.some((f, i) => f[0] !== to[i]?.[0] || f[1] !== to[i]?.[1]);

    const at = (k: number): ChartFrame =>
        k >= 1
            ? final
            : {
                  data: [
                      union,
                      from.map((f, i) => mix(f[0] ?? 0, to[i]?.[0] ?? 0, k)),
                      from.map((f, i) => mix(f[1] ?? 0, to[i]?.[1] ?? 0, k))
                  ],
                  x: [mix(start.x[0], final.x[0], k), mix(start.x[1], final.x[1], k)],
                  top: mix(start.top, final.top, k)
              };

    return { at, moves };
}
