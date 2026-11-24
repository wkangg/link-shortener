// Local days for charts. A single UTC offset puts some clicks on the wrong day once
// a range crosses a daylight saving change, so with a zone name each click is
// shifted by the offset in force when it happened.
const MINUTE = 60_000;
const DAY = 86_400_000;

/** From `from` (ms, UTC) on, local time is UTC plus `offset` minutes. */
interface OffsetPeriod {
    from: number;
    offset: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat | null {
    let f = formats.get(zone);
    if (f) return f;
    try {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: zone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric'
        });
    } catch {
        return null;
    }
    // Only names as Intl spells them are kept (not every casing of one), so the cache
    // stays small.
    if (f.resolvedOptions().timeZone === zone) formats.set(zone, f);
    return f;
}

/** Minutes to add to UTC for local time in `zone` at `t`. */
export function zoneOffset(zone: string, t: number): number {
    const f = format(zone);
    if (!f) throw new Error(`Unknown time zone: ${zone}`);
    const parts = f.formatToParts(t);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find(p => p.type === type)?.value);
    const local = Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute')
    );
    return Math.round((local - Math.floor(t / MINUTE) * MINUTE) / MINUTE);
}

/**
 * The offsets `zone` uses during [from, to), each from the minute it starts. Zones
 * change offset a few times a year at most, never twice in a day: each day is
 * checked, and a change is narrowed down to its minute.
 */
function offsetPeriods(zone: string, from: number, to: number): OffsetPeriod[] {
    const periods: OffsetPeriod[] = [{ from, offset: zoneOffset(zone, from) }];
    let start = from;
    let offset = periods[0]?.offset ?? 0;
    while (start < to - 1) {
        const end = Math.min(start + DAY, to - 1);
        const next = zoneOffset(zone, end);
        if (next !== offset) {
            // `lo` has the old offset and `hi` the new one; close in until they're a
            // minute apart. Offsets change on a whole minute, so it's the one after `lo`.
            let lo = start;
            let hi = end;
            while (hi - lo > MINUTE) {
                const mid = lo + Math.floor((hi - lo) / 2);
                if (zoneOffset(zone, mid) === offset) lo = mid;
                else hi = mid;
            }
            periods.push({ from: Math.floor(lo / MINUTE) * MINUTE + MINUTE, offset: next });
            offset = next;
        }
        start = end;
    }
    return periods;
}

/** Converts between UTC and local time over one query's range. */
export class LocalClock {
    readonly #periods: OffsetPeriod[];

    /**
     * Local time in `zone` (an IANA name such as America/Toronto) over [from, to),
     * or UTC plus `tz` minutes throughout when no zone is given or this server doesn't
     * know it (a browser can report one newer than its time zone data, or Etc/Unknown).
     */
    constructor(opts: { zone?: string; tz?: number }, from: number, to: number) {
        // As Intl spells it, so lookups hit the cache whatever casing was sent.
        const zone = opts.zone && format(opts.zone)?.resolvedOptions().timeZone;
        // From a day early: the first local day can start before `from`, and on the far
        // side of a change.
        this.#periods = zone
            ? offsetPeriods(zone, from - DAY, to)
            : [{ from, offset: opts.tz ?? 0 }];
    }

    /** Minutes to add to UTC at `t`. */
    offsetAt(t: number): number {
        let offset = this.#periods[0]?.offset ?? 0;
        for (const p of this.#periods) if (p.from <= t) offset = p.offset;
        return offset;
    }

    /** `t` as local time (ms since 1970 on the local calendar). */
    local(t: number): number {
        return t + this.offsetAt(t) * MINUTE;
    }

    /** The UTC time of a local time: the earlier one when the clocks repeat it. */
    utc(local: number): number {
        // Each offset in force gives a candidate, which counts if that offset is in force
        // then. A local time the clocks went back over has two; one they skipped, none.
        let earliest = Infinity;
        for (const { offset } of this.#periods) {
            const t = local - offset * MINUTE;
            if (t < earliest && this.offsetAt(t) === offset) earliest = t;
        }
        if (earliest !== Infinity) return earliest;
        const guess = local - this.offsetAt(local) * MINUTE;
        const t = local - this.offsetAt(guess) * MINUTE;
        if (this.local(t) >= local) return t;
        // The clocks jumped past `local` (some zones skip midnight): it starts when they jump.
        return this.#periods.find(p => p.from > t)?.from ?? t;
    }

    /** SQL for `column` (UTC ms) as local time, with the offset in force at each row. */
    sql(column: string): { sql: string; params: number[] } {
        const [first, ...later] = this.#periods;
        const base = (first?.offset ?? 0) * MINUTE;
        if (later.length === 0) return { sql: `(${column} + ?)`, params: [base] };
        // Latest first, so each WHEN only needs the start of its period.
        const newest = later.toReversed();
        return {
            sql: `(${column} + CASE ${newest.map(() => `WHEN ${column} >= ? THEN ?`).join(' ')} ELSE ? END)`,
            params: [...newest.flatMap(p => [p.from, p.offset * MINUTE]), base]
        };
    }
}
