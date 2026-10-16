// VPN and relay address lists, from free public sources:
//
//   Tor                   the Tor Project's exit list (refreshed every 6 hours)
//   iCloud Private Relay  Apple's published egress ranges (refreshed daily)
//   Cloudflare WARP       not published by Cloudflare; the blocks its consumer WARP
//                         egress is known to come from are listed below. Apple's list
//                         is checked first, since Private Relay shares some of them.
//
// Fetched lists are merged into sorted ranges and stored in `ip_lists`, so a
// restart doesn't need the network and a failed fetch keeps the last good copy.
import type { Database } from 'bun:sqlite';
import { isIP } from 'node:net';

const HOUR = 3_600_000;

/** An inclusive address range: numbers for IPv4, bigints for IPv6. */
type Range<T> = [start: T, end: T];

function parseV4(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const byte = Number(part);
        if (byte > 255) return null;
        n = n * 256 + byte;
    }
    return n;
}

function parseV6(ip: string): bigint | null {
    if (isIP(ip) !== 6) return null;
    let text = ip.split('%')[0] ?? '';
    // A trailing dotted quad (::ffff:1.2.3.4) is two groups.
    const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (quad?.[1]) {
        const v4 = parseV4(quad[1]);
        if (v4 === null) return null;
        text = `${text.slice(0, -quad[1].length)}${(v4 >>> 16).toString(16)}:${(v4 % 65_536).toString(16)}`;
    }
    const [head = '', tail] = text.split('::');
    const left = head === '' ? [] : head.split(':');
    const right = tail === undefined || tail === '' ? [] : tail.split(':');
    const missing = 8 - left.length - right.length;
    if (tail === undefined ? missing !== 0 : missing < 0) return null;
    let n = 0n;
    for (const group of [...left, ...Array.from({ length: missing }, () => '0'), ...right]) {
        n = (n << 16n) | BigInt(Number.parseInt(group, 16));
    }
    return n;
}

/** Sorts and merges overlapping or adjacent ranges. */
function merge<T extends number | bigint>(ranges: Range<T>[], one: T): Range<T>[] {
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out: Range<T>[] = [];
    for (const [start, end] of ranges) {
        const last = out.at(-1);
        if (last && start <= (last[1] as number) + (one as number)) {
            if (end > last[1]) last[1] = end;
        } else {
            out.push([start, end]);
        }
    }
    return out;
}

function contains<T extends number | bigint>(ranges: Range<T>[], value: T): boolean {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const range = ranges[mid];
        if (!range) return false;
        if (value < range[0]) hi = mid - 1;
        else if (value > range[1]) lo = mid + 1;
        else return true;
    }
    return false;
}

/** A set of IPv4 and IPv6 ranges with fast membership checks. */
export class RangeSet {
    readonly #v4: Range<number>[];
    readonly #v6: Range<bigint>[];

    private constructor(v4: Range<number>[], v6: Range<bigint>[]) {
        this.#v4 = merge(v4, 1);
        this.#v6 = merge(v6, 1n);
    }

    /** From CIDRs or bare addresses; anything unparseable is skipped. */
    static fromCidrs(cidrs: Iterable<string>): RangeSet {
        const v4: Range<number>[] = [];
        const v6: Range<bigint>[] = [];
        for (const raw of cidrs) {
            const [addr = '', bits] = raw.trim().split('/');
            const prefix = bits === undefined ? null : Number(bits);
            if (prefix !== null && !(Number.isInteger(prefix) && prefix >= 0)) continue;
            const a4 = parseV4(addr);
            if (a4 !== null) {
                const p = prefix ?? 32;
                if (p > 32) continue;
                const size = 2 ** (32 - p);
                const start = a4 - (a4 % size);
                v4.push([start, start + size - 1]);
                continue;
            }
            const a6 = parseV6(addr);
            if (a6 !== null) {
                const p = BigInt(prefix ?? 128);
                if (p > 128n) continue;
                const host = (1n << (128n - p)) - 1n;
                v6.push([a6 & ~host, a6 | host]);
            }
        }
        return new RangeSet(v4, v6);
    }

    /** Reads what `serialize()` wrote. */
    static deserialize(text: string): RangeSet {
        const v4: Range<number>[] = [];
        const v6: Range<bigint>[] = [];
        for (const line of text.split('\n')) {
            const m = /^([46]):([\da-f]+)-([\da-f]+)$/.exec(line);
            if (!m?.[2] || !m[3]) continue;
            if (m[1] === '4') v4.push([Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)]);
            else v6.push([BigInt(`0x${m[2]}`), BigInt(`0x${m[3]}`)]);
        }
        return new RangeSet(v4, v6);
    }

    serialize(): string {
        return [
            ...this.#v4.map(([s, e]) => `4:${s.toString(16)}-${e.toString(16)}`),
            ...this.#v6.map(([s, e]) => `6:${s.toString(16)}-${e.toString(16)}`)
        ].join('\n');
    }

    get size(): number {
        return this.#v4.length + this.#v6.length;
    }

    has(ip: string): boolean {
        const v4 = parseV4(ip);
        if (v4 !== null) return contains(this.#v4, v4);
        const v6 = parseV6(ip);
        if (v6 === null) return false;
        // IPv4-mapped IPv6 (::ffff:a.b.c.d) is the IPv4 address.
        if (v6 >> 32n === 65_535n) return contains(this.#v4, Number(v6 % 4_294_967_296n));
        return contains(this.#v6, v6);
    }
}

interface ListSource {
    name: string;
    /** Shown on the click, e.g. "Tor". */
    label: string;
    url: string;
    maxAgeMs: number;
    /** Addresses or CIDRs from the downloaded text. */
    entries: (text: string) => string[];
}

const SOURCES: readonly ListSource[] = [
    {
        name: 'tor',
        label: 'Tor',
        url: 'https://check.torproject.org/torbulkexitlist',
        maxAgeMs: 6 * HOUR,
        entries: text => text.split('\n').filter(line => line !== '' && !line.startsWith('#'))
    },
    {
        name: 'icloud',
        label: 'iCloud Private Relay',
        url: 'https://mask-api.icloud.com/egress-ip-ranges.csv',
        maxAgeMs: 24 * HOUR,
        // prefix,country,region,city,
        entries: text => text.split('\n').map(line => line.slice(0, line.indexOf(',')))
    }
];

/** Cloudflare's consumer WARP egress blocks (not officially published). */
const WARP = {
    label: 'Cloudflare WARP',
    ranges: RangeSet.fromCidrs(['104.28.0.0/14', '2a09:bac0::/29'])
};

export type FetchText = (url: string) => Promise<string>;

export function fetchText(timeoutMs = 60_000): FetchText {
    return async url => {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status} ${res.statusText}`);
        return res.text();
    };
}

export interface VpnListsOptions {
    /** Downloads a list; null never fetches (only stored lists are used). */
    fetchText?: FetchText | null;
    now?: () => number;
}

/** Answers "is this IP a known VPN or relay exit, and which?" */
export class VpnLists {
    readonly #fetch: FetchText | null;
    readonly #now: () => number;
    readonly #lists = new Map<string, { ranges: RangeSet; fetchedAt: number }>();
    readonly #upsert;
    #timer: ReturnType<typeof setInterval> | null = null;
    #refreshing: Promise<boolean> | null = null;

    constructor(db: Database, opts: VpnListsOptions = {}) {
        this.#fetch = opts.fetchText === undefined ? fetchText() : opts.fetchText;
        this.#now = opts.now ?? Date.now;
        const rows = db
            .query<{ name: string; ranges: string; fetched_at: number }, []>(
                'SELECT name, ranges, fetched_at FROM ip_lists'
            )
            .all();
        for (const row of rows) {
            this.#lists.set(row.name, {
                ranges: RangeSet.deserialize(row.ranges),
                fetchedAt: row.fetched_at
            });
        }
        this.#upsert = db.query(
            `INSERT INTO ip_lists (name, ranges, fetched_at) VALUES (?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET ranges = excluded.ranges, fetched_at = excluded.fetched_at`
        );
    }

    /** The VPN or relay the IP belongs to (e.g. "Tor"), or null. */
    lookup(ip: string): string | null {
        for (const source of SOURCES) {
            if (this.#lists.get(source.name)?.ranges.has(ip)) return source.label;
        }
        return WARP.ranges.has(ip) ? WARP.label : null;
    }

    /** Downloads lists older than their max age. Resolves to whether any list changed. */
    refresh(): Promise<boolean> {
        this.#refreshing ??= this.#refresh().finally(() => {
            this.#refreshing = null;
        });
        return this.#refreshing;
    }

    async #refresh(): Promise<boolean> {
        const fetch = this.#fetch;
        if (!fetch) return false;
        let changed = false;
        for (const source of SOURCES) {
            const known = this.#lists.get(source.name);
            if (known && this.#now() - known.fetchedAt < source.maxAgeMs) continue;
            try {
                const ranges = RangeSet.fromCidrs(source.entries(await fetch(source.url)));
                // An empty or broken download keeps the last good list.
                if (ranges.size === 0) throw new Error(`${source.url} had no addresses`);
                const text = ranges.serialize();
                const fetchedAt = this.#now();
                if (known?.ranges.serialize() !== text) changed = true;
                this.#upsert.run(source.name, text, fetchedAt);
                this.#lists.set(source.name, { ranges, fetchedAt });
            } catch (error) {
                console.error(
                    `[vpn] couldn't update the ${source.label} list:`,
                    error instanceof Error ? error.message : error
                );
            }
        }
        return changed;
    }

    /** Refreshes now and then hourly (each list only when stale); `onChange` runs after a change. */
    start(onChange: () => void): void {
        if (this.#timer) return;
        const run = () => {
            void this.refresh().then(changed => {
                if (changed) onChange();
            });
        };
        run();
        this.#timer = setInterval(run, HOUR);
        this.#timer.unref();
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
    }

    get stats() {
        return Object.fromEntries(
            [...this.#lists].map(([name, l]) => [
                name,
                { ranges: l.ranges.size, fetchedAt: l.fetchedAt }
            ])
        );
    }
}
