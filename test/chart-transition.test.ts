import { describe, expect, test } from 'bun:test';

import { type ChartSnapshot, chartTransition } from '../src/dashboard/client/chartTransition.ts';
import type { TimeseriesResponse } from '../src/shared/types.ts';

const DAY = 86_400;

/** Daily data starting at day `first`, one clicks value per day (visitors = half). */
function days(first: number, clicks: number[]): TimeseriesResponse {
    return {
        interval: 'day',
        points: clicks.map((c, i) => ({ t: (first + i) * DAY * 1000, clicks: c, visitors: c / 2 }))
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

    test('hours after days rise from 0 instead of easing from a whole day', () => {
        const before = settled(days(0, [100, 200]));
        const hours: TimeseriesResponse = {
            interval: 'hour',
            points: [{ t: 0, clicks: 3, visitors: 1 }]
        };
        const { at } = chartTransition(before, hours);
        expect(at(0).data).toEqual([[0], [0], [0]]);
    });
});
