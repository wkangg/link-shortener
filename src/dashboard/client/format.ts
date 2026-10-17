const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

export const formatCount = (n: number) => (n >= 10_000 ? compact.format(n) : whole.format(n));

export function formatDelta(current: number, previous: number): string | null {
    if (previous === 0) return current === 0 ? null : 'new';
    const pct = Math.round(((current - previous) / previous) * 100);
    return pct === 0 ? 'no change' : `${pct > 0 ? '+' : ''}${pct}%`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export const formatDateTime = (ms: number) => dateTime.format(ms);
export const formatDate = (ms: number) => date.format(ms);

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const RELATIVE_UNITS = [
    ['year', 365 * 24 * 3_600_000],
    ['month', 30 * 24 * 3_600_000],
    ['week', 7 * 24 * 3_600_000],
    ['day', 24 * 3_600_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
] as const;

/** "3 minutes ago", "5 hours ago", "yesterday"; "just now" under a minute. */
export function formatRelative(ms: number, now = Date.now()): string {
    const diff = ms - now;
    for (const [unit, size] of RELATIVE_UNITS) {
        if (Math.abs(diff) >= size) return relative.format(Math.trunc(diff / size), unit);
    }
    return 'just now';
}

/** "s.example" from "https://s.example". */
export const hostOf = (origin: string) => origin.replace(/^https?:\/\//, '');

const regionNames =
    typeof Intl.DisplayNames === 'function'
        ? new Intl.DisplayNames(undefined, { type: 'region' })
        : null;

/** U+1F1E6, the regional indicator for "A"; flags are two of these. */
const REGIONAL_INDICATOR_A = 127_462;

/** Flag emoji + country name for an ISO 3166-1 alpha-2 code. */
export function countryLabel(code: string): string {
    if (!/^[A-Z]{2}$/.test(code)) return code;
    const flag = String.fromCodePoint(
        ...[...code].map(c => REGIONAL_INDICATOR_A + (c.codePointAt(0) ?? 65) - 65)
    );
    let name = code;
    try {
        name = regionNames?.of(code) ?? code;
    } catch {
        // Unknown code: keep it as is.
    }
    return `${flag} ${name}`;
}
