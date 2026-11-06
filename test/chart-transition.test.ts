import { describe, expect, test } from 'bun:test';

import {
    carryZoom,
    type ChartSnapshot,
    chartTransition,
    clampZoom
} from '../src/dashboard/client/chartTransition.ts';
import type { TimeseriesResponse } from '../src/shared/types.ts';

const DAY = 86_400;

/** Daily data starting at day `first`, one clicks value per day (visitors = half). */
function days(first: number, clicks: number[]): TimeseriesResponse {
    return {
        interval: 'day',
        points: clicks.map((c, i) => ({ t: (first + i) * DAY * 1000, clicks: c, visitors: c / 2 }))
    };
}

/** `n` hours of one click each, starting at hour `first`. */
function hours(first: number, n: number): TimeseriesResponse {
    return {
        interval: 'hour',
        points: Array.from({ length: n }, (_, i) => ({
            t: (first + i) * 3600 * 1000,
            clicks: 1,
            visitors: 1
        }))
    };
}

/** What's on screen once `data` has finished easing in. */
function settled(data: TimeseriesResponse): ChartSnapshot {
    return { ...chartTransition(null, data).at(1), interval: data.interval };
}

describe('chartTransition', () => {
    test('first load rises from 0 in the final view', () => {
        const data = days(0, [10, 20]);
        const { at, moves } = chartTransition(null, data);
        expect(moves).toBe(true);
        expect(at(0).data).toEqual([
            [0, DAY],
            [0, 0],
            [0, 0]
        ]);
        expect(at(0).x).toEqual(at(1).x);
        expect(at(0).top).toBe(at(1).top);
        expect(at(0.5).data[1]).toEqual([5, 10]);
    });

    test('a shorter range zooms in, keeping the days that leave until they are out of view', () => {
        const before = settled(days(0, [5, 5, 5, 8, 9]));
        const { at, moves } = chartTransition(before, days(3, [8, 9]));
        expect(moves).toBe(true);
        // The view starts where it was, with all five days still drawn.
        expect(at(0).x).toEqual([0, 4 * DAY]);
        expect(at(0).data[0]).toHaveLength(5);
        expect(at(0.5).x).toEqual([1.5 * DAY, 4 * DAY]);
        // Days in both ranges keep their values; days leaving don't drop to 0.
        expect(at(0.5).data[1]).toEqual([5, 5, 5, 8, 9]);
        // At the end only the new days are left.
        expect(at(1).data).toEqual([
            [3 * DAY, 4 * DAY],
            [8, 9],
            [4, 4.5]
        ]);
    });

    test('a longer range zooms out, with new days already at their values', () => {
        const before = settled(days(3, [8, 9]));
        const { at } = chartTransition(before, days(0, [5, 6, 7, 8, 9]));
        expect(at(0).x).toEqual([3 * DAY, 4 * DAY]);
        expect(at(0).data[1]).toEqual([5, 6, 7, 8, 9]);
    });

    test('changed values ease and the y axis follows', () => {
        const before = settled(days(0, [10, 20]));
        const { at } = chartTransition(before, days(0, [30, 40]));
        expect(at(0.5).data[1]).toEqual([20, 30]);
        expect(at(0).top).toBeCloseTo(22);
        expect(at(1).top).toBeCloseTo(44);
    });

    test('unchanged data does not animate', () => {
        const data = days(0, [10, 20]);
        expect(chartTransition(settled(data), data).moves).toBe(false);
    });

    test('days to hours zooms in, starting from the day line rescaled to hours', () => {
        const before = settled(days(0, [48, 96]));
        const hours: TimeseriesResponse = {
            interval: 'hour',
            points: [0, 12, 24].map(h => ({ t: h * 3600 * 1000, clicks: 1, visitors: 1 }))
        };
        const { at } = chartTransition(before, hours);
        // Same picture as before: values and y axis both / 24.
        expect(at(0).x).toEqual([0, DAY]);
        expect(at(0).top).toBeCloseTo(before.top / 24);
        // Hour 12 sits halfway between the two days: (2 + 4) / 2 per hour.
        expect(at(0).data).toEqual([
            [0, 12 * 3600, DAY],
            [2, 3, 4],
            [1, 1.5, 2]
        ]);
        expect(at(1).data[1]).toEqual([1, 1, 1]);
    });

    test('a range that does not overlap still lands on the data', () => {
        const before = settled(days(0, [10]));
        const { at } = chartTransition(before, days(5, [20, 30]));
        expect(at(1).data).toEqual([
            [5 * DAY, 6 * DAY],
            [20, 30],
            [10, 15]
        ]);
    });
});

describe('chartTransition with a zoom', () => {
    test('zooming in moves only the view, with the y axis fitted to the lines in it', () => {
        const data = days(0, [10, 100, 10, 20, 30]);
        const before = settled(data);
        const { at, moves } = chartTransition(before, data, [2 * DAY, 4 * DAY]);
        expect(moves).toBe(true);
        expect(at(0).x).toEqual([0, 4 * DAY]);
        expect(at(0).top).toBeCloseTo(110);
        // The lines stay put while the view moves.
        expect(at(0.5).data).toEqual(before.data);
        expect(at(1).x).toEqual([2 * DAY, 4 * DAY]);
        expect(at(1).top).toBeCloseTo(33);
    });

    test('the y axis counts where the lines cross the edges of the zoom', () => {
        const data = days(0, [0, 100]);
        // Halfway through the rise to 100, which is outside the zoom.
        const { at } = chartTransition(null, data, [0, DAY / 2]);
        expect(at(1).top).toBeCloseTo(55);
    });

    test('zooming back out starts from the zoomed view', () => {
        const data = days(0, [10, 100, 10, 20, 30]);
        const zoomed = {
            ...chartTransition(null, data, [2 * DAY, 4 * DAY]).at(1),
            interval: data.interval
        };
        const { at } = chartTransition(zoomed, data);
        expect(at(0).x).toEqual([2 * DAY, 4 * DAY]);
        expect(at(0).top).toBeCloseTo(33);
        expect(at(1).x).toEqual([0, 4 * DAY]);
    });

    test('zooming out lifts the y axis for a peak the view reaches before the axis would', () => {
        const data = days(0, [10, 100, 10, 20, 30]);
        const zoomed = {
            ...chartTransition(null, data, [2 * DAY, 4 * DAY]).at(1),
            interval: data.interval
        };
        const { at } = chartTransition(zoomed, data);
        // Halfway, the view reaches back to day 1 (100 clicks), though the eased top is 71.5.
        expect(at(0.5).x).toEqual([DAY, 4 * DAY]);
        expect(at(0.5).top).toBeCloseTo(110);
        for (const k of [0.1, 0.3, 0.5, 0.7, 0.9]) {
            const { data: frame, x, top } = at(k);
            const inView = frame[0].flatMap((t, i) =>
                t >= x[0] && t <= x[1] ? [frame[1][i] ?? 0, frame[2][i] ?? 0] : []
            );
            expect(top).toBeGreaterThanOrEqual(Math.max(...inView));
        }
    });

    test('new data eases from the zoomed view into the same zoom', () => {
        const zoom: [number, number] = [1 * DAY, 3 * DAY];
        const before = {
            ...chartTransition(null, days(0, [1, 2, 3, 4, 5]), zoom).at(1),
            interval: 'day' as const
        };
        const { at, moves } = chartTransition(before, days(0, [1, 2, 9, 4, 5]), zoom);
        expect(moves).toBe(true);
        expect(at(0).x).toEqual(zoom);
        expect(at(1).x).toEqual(zoom);
        expect(at(1).top).toBeCloseTo(9.9);
    });
});

describe('clampZoom', () => {
    const data = days(10, [1, 2, 3, 4, 5]);

    test('keeps a zoom inside the data', () => {
        expect(clampZoom([11 * DAY, 13 * DAY], data)).toEqual([11 * DAY, 13 * DAY]);
    });

    test('is null for no zoom, the whole range, or a span outside the data', () => {
        expect(clampZoom(null, data)).toBeNull();
        expect(clampZoom([10 * DAY, 14 * DAY], data)).toBeNull();
        expect(clampZoom([5 * DAY, 20 * DAY], data)).toBeNull();
        expect(clampZoom([2 * DAY, 4 * DAY], data)).toBeNull();
        expect(clampZoom([12 * DAY, 12 * DAY], data)).toBeNull();
    });

    test('pulls in an edge up to a bucket past the data', () => {
        expect(clampZoom([9.5 * DAY, 12 * DAY], data)).toEqual([10 * DAY, 12 * DAY]);
        expect(clampZoom([12 * DAY, 14.5 * DAY], data)).toEqual([12 * DAY, 14 * DAY]);
    });

    test('drops a zoom more than a bucket past the data', () => {
        expect(clampZoom([8 * DAY, 12 * DAY], data)).toBeNull();
    });

    test('is null with fewer than two buckets', () => {
        expect(clampZoom([10 * DAY, 11 * DAY], days(10, [1]))).toBeNull();
    });
});

describe('carryZoom', () => {
    test('keeps a zoom the new data still covers', () => {
        const before = days(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const after = days(3, [4, 5, 6, 7, 8, 9, 10]);
        expect(carryZoom([4 * DAY, 6 * DAY], before, after)).toEqual([4 * DAY, 6 * DAY]);
    });

    test('resets when the new range no longer covers the zoom', () => {
        const before = days(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const after = days(7, [8, 9, 10]);
        expect(carryZoom([2 * DAY, 4 * DAY], before, after)).toBeNull();
    });

    test('a zoom onto the newest bucket follows it, keeping its width', () => {
        const before = days(0, [1, 2, 3, 4, 5]);
        const after = days(1, [2, 3, 4, 5, 6]);
        expect(carryZoom([2 * DAY, 4 * DAY], before, after)).toEqual([3 * DAY, 5 * DAY]);
    });

    test('a zoom from the oldest bucket survives it rolling out of range', () => {
        const zoom: [number, number] = [0, 6 * 3600];
        expect(carryZoom(zoom, hours(0, 24), hours(1, 24))).toEqual([3600, 6 * 3600]);
    });

    test('a drag that lands a float short of the newest bucket still follows it', () => {
        const before = days(0, [1, 2, 3, 4, 5]);
        const after = days(1, [2, 3, 4, 5, 6]);
        expect(carryZoom([2 * DAY, 4 * DAY - 0.5], before, after)).toEqual([
            3 * DAY + 0.5,
            5 * DAY
        ]);
    });

    test('resets when the bucket size changes', () => {
        // The last 6 of 24 hours, then the last 7 days: at most one day point would be in view.
        expect(
            carryZoom([18 * 3600, 23 * 3600], hours(0, 24), days(-6, [1, 2, 3, 4, 5, 6, 7]))
        ).toBeNull();
        // The last of 7 days, then the last 24 hours.
        expect(
            carryZoom([5 * DAY, 6 * DAY], days(0, [1, 2, 3, 4, 5, 6, 7]), hours(144, 24))
        ).toBeNull();
    });

    test('no zoom stays no zoom', () => {
        const data = days(0, [1, 2]);
        expect(carryZoom(null, data, data)).toBeNull();
    });
});
