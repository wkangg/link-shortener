import type { TimeseriesResponse } from '../../shared/types.ts';

/** A time span (unix seconds), first to last. */
export type Span = [min: number, max: number];

/** What the chart shows at one moment: its lines and the view around them. */
export interface ChartFrame {
    /** Bucket starts (unix seconds), then clicks and unique visitors per bucket. */
    data: [xs: number[], clicks: number[], visitors: number[]];
    /** The visible time span. */
    x: Span;
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

/** The span `data` covers, from its first bucket to its last. */
export function fullSpan(data: TimeseriesResponse): Span {
    return [(data.points[0]?.t ?? 0) / 1000, (data.points.at(-1)?.t ?? 0) / 1000];
}

/**
 * `zoom` fitted to `data`: null (the whole range) when it covers all of the data, falls
 * outside it or has no width. An edge up to one bucket past the data is pulled in,
 * so a zoom onto the oldest bucket survives that bucket rolling out of a refreshed range.
 */
export function clampZoom(zoom: Span | null, data: TimeseriesResponse): Span | null {
    if (!zoom || data.points.length < 2) return null;
    const [first, last] = fullSpan(data);
    const bucket = BUCKET[data.interval];
    let [min, max] = zoom;
    if (min < first && first - min <= bucket) min = first;
    if (max > last && max - last <= bucket) max = last;
    if (min < first || max > last || max <= min) return null;
    if (min === first && max === last) return null;
    return [min, max];
}

/**
 * The zoom to keep when `before` is replaced by `data` (a refresh or a filter change). A
 * zoom that reached the newest bucket follows the newest bucket, keeping its width, so
 * new buckets slide into view. Otherwise it stays put while `data` still covers it (see
 * `clampZoom`), and resets to the whole range when it doesn't.
 */
export function carryZoom(
    zoom: Span | null,
    before: TimeseriesResponse | null,
    data: TimeseriesResponse
): Span | null {
    if (!zoom) return null;
    let [min, max] = zoom;
    // Within a second, since a drag to the plot's edge can land a float's error short of it.
    if (before && before.points.length > 0 && max >= fullSpan(before)[1] - 1) {
        const shift = fullSpan(data)[1] - max;
        min += shift;
        max += shift;
    }
    return clampZoom([min, max], data);
}

/** The y axis's top for `lines` viewed over `view`: their points in it, and where they cross its edges. */
function topIn(xs: number[], lines: number[][], [min, max]: Span): number {
    let peak = 0;
    for (const ys of lines) {
        for (const [i, x] of xs.entries()) {
            if (x >= min && x <= max) peak = Math.max(peak, ys[i] ?? 0);
        }
        peak = Math.max(peak, valueAt(xs, ys, min) ?? 0, valueAt(xs, ys, max) ?? 0);
    }
    return yTop(peak);
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
 *
 * The final view is `zoom` when given (from `clampZoom` or `carryZoom`), with the y axis
 * fitted to the lines in it, or else the whole range. Zooming in or out on the same data
 * is a transition like any other, in which only the view moves.
 */
export function chartTransition(
    before: ChartSnapshot | null,
    data: TimeseriesResponse,
    zoom: Span | null = null
): { at: (k: number) => ChartFrame; moves: boolean } {
    const xs = data.points.map(p => p.t / 1000);
    const clicks = data.points.map(p => p.clicks);
    const visitors = data.points.map(p => p.visitors);
    const final: ChartFrame = {
        data: [xs, clicks, visitors],
        x: zoom ?? fullSpan(data),
        top: zoom ? topIn(xs, [clicks, visitors], zoom) : yTop(Math.max(0, ...clicks, ...visitors))
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
