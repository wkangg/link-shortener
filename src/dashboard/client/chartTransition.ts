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

/** Bucket sizes in seconds. */
const BUCKET = { hour: 3600, day: 86_400 } as const;

/** The line's value at `x`: exact on a point, read between its neighbours, or null outside it. */
function valueAt(xs: number[], ys: number[], x: number): number | null {
    const i = xs.findIndex(v => v >= x);
    const x1 = xs[i];
    const y1 = ys[i];
    if (x1 === undefined || y1 === undefined) return null;
    if (x1 === x) return y1;
    const x0 = xs[i - 1];
    const y0 = ys[i - 1];
    if (x0 === undefined || y0 === undefined) return null;
    return mix(y0, y1, (x - x0) / (x1 - x0));
}

/**
 * Frames from what was on screen (`before`) to `data`, for progress `k` from 0 to 1.
 *
 * The view pans and zooms from the old time span and y axis to the new ones, like a
 * camera, while the old line morphs into the new one. Where one line has a point the
 * other doesn't, the other is read between its neighbouring points; points leaving the
 * range stay put as they move out of view, and points coming in appear at their values.
 * Between hours and days, the old line is first rescaled to the new bucket size (a day's
 * clicks / 24 per hour), with its y axis, so it starts exactly where it was drawn. With
 * nothing before, the lines rise from 0 in the final view.
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

    let start: ChartFrame = { ...final, data: [xs, xs.map(() => 0), xs.map(() => 0)] };
    if (before) {
        const scale = BUCKET[data.interval] / BUCKET[before.interval];
        const [bx, bc, bv] = before.data;
        start = {
            data: [bx, bc.map(v => v * scale), bv.map(v => v * scale)],
            x: before.x,
            top: before.top * scale
        };
    }

    const [sx, sc, sv] = start.data;
    const union = [...new Set([...sx, ...xs])].toSorted((a, b) => a - b);
    const ends = (x: number) => {
        const from = [valueAt(sx, sc, x), valueAt(sx, sv, x)];
        const to = [valueAt(xs, clicks, x), valueAt(xs, visitors, x)];
        return {
            from: from.map((v, i) => v ?? to[i] ?? 0),
            to: to.map((v, i) => v ?? from[i] ?? 0)
        };
    };
    const lines = union.map(x => ends(x));

    const moves =
        start.top !== final.top ||
        start.x[0] !== final.x[0] ||
        start.x[1] !== final.x[1] ||
        union.length !== xs.length ||
        lines.some(l => l.from[0] !== l.to[0] || l.from[1] !== l.to[1]);

    const at = (k: number): ChartFrame =>
        k >= 1
            ? final
            : {
                  data: [
                      union,
                      lines.map(l => mix(l.from[0] ?? 0, l.to[0] ?? 0, k)),
                      lines.map(l => mix(l.from[1] ?? 0, l.to[1] ?? 0, k))
                  ],
                  x: [mix(start.x[0], final.x[0], k), mix(start.x[1], final.x[1], k)],
                  top: mix(start.top, final.top, k)
              };

    return { at, moves };
}
