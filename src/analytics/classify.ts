// Splits suspicious traffic into two groups the dashboard can toggle separately:
//
//   VPN / relay  a person whose traffic leaves through a VPN, Tor or a relay.
//                Shown by default.
//   scraper      a script or headless browser that doesn't declare itself as a
//                bot (declared crawlers are `is_bot`). Hidden by default.
//
// A hosting/datacenter IP on its own says neither: VPN exits and scraping
// boxes live on the same networks. What tells them apart is mostly behaviour.
// A person's browser runs the device-signals page, sends Accept-Language and
// has a local clock. A script usually skips the page, sends bare headers, and
// runs on a server clock set to UTC.
//
// Every verdict is recomputed from stored facts, so it can be redone whenever
// a fact arrives late (hostname, ISP, browser signals) or a list changes.
import type { Database } from 'bun:sqlite';

/** Signals must arrive within this long of the click; unused tokens are cleared after it. */
export const SIGNALS_WINDOW_MS = 10 * 60_000;

/** What classification looks at, per click. 0/1 columns as stored. */
export interface ClickFacts {
    ts: number;
    ip: string | null;
    ua: string | null;
    is_bot: number;
    /** Accept-Language, or the browser's language once signals arrive. */
    language: string | null;
    timezone: string | null;
    /** null = no signals page served, 0 = served but nothing came back, 1 = ran. */
    js: number | null;
    webdriver: number | null;
    gpu: string | null;
    hostname: string | null;
    isp: string | null;
    is_datacenter: number;
}

export interface Verdict {
    /** The VPN or relay, e.g. "Tor" or "VPN host: M247". */
    vpn: string | null;
    /** Why the click looks automated. */
    scraper: string | null;
}

/** Looks an IP up in the VPN / relay lists (see analytics/vpn.ts). */
export type VpnLookup = (ip: string) => string | null;

// Hosting companies that mostly rent servers to VPN services. Matched against
// the reverse-DNS hostname and the ISP name. Their IPs are still hosting IPs, so
// a click from one counts as a VPN only when it doesn't look automated.
const VPN_HOSTS: [RegExp, string][] = [
    [/\bm247\b/i, 'M247'],
    [/datacamp|cdn77/i, 'Datacamp / CDN77'],
    [/packethub/i, 'Packethub'],
    [/clouvider/i, 'Clouvider'],
    [/31173 services|mullvad/i, 'Mullvad'],
    [/\bproton (?:ag|vpn)\b|protonvpn/i, 'Proton VPN'],
    [/tefincom|nordvpn/i, 'NordVPN'],
    [/surfshark/i, 'Surfshark'],
    [/expressvpn/i, 'ExpressVPN'],
    [/hostroyale/i, 'HostRoyale'],
    [/creanova/i, 'Creanova'],
    [/private layer/i, 'Private Layer'],
    [/tzulo/i, 'tzulo']
];

const UTC_ZONES = new Set([
    'utc',
    'etc/utc',
    'gmt',
    'etc/gmt',
    'universal',
    'etc/universal',
    'zulu',
    'etc/zulu',
    'uct',
    'etc/uct'
]);

// What headless Chrome and browsers in GPU-less containers report as their renderer.
const SOFTWARE_GPU_RE = /swiftshader|llvmpipe|softpipe/i;

function vpnHost(facts: ClickFacts): string | null {
    const text = `${facts.hostname ?? ''} ${facts.isp ?? ''}`;
    return VPN_HOSTS.find(([re]) => re.test(text))?.[1] ?? null;
}

export function classify(facts: ClickFacts, lookup: VpnLookup, now: number): Verdict {
    const listed = facts.ip ? lookup(facts.ip) : null;
    // Declared bots are their own category.
    if (facts.is_bot === 1) return { vpn: listed, scraper: null };

    const host = vpnHost(facts);
    const hosting = listed === null && (facts.is_datacenter === 1 || host !== null);
    const jsRan = facts.js === 1;
    const jsSkipped = facts.js === 0 && facts.ts <= now - SIGNALS_WINDOW_MS;

    let scraper: string | null = null;
    if (!facts.ua) scraper = 'No user agent';
    else if (facts.webdriver === 1) scraper = 'Automated browser (webdriver)';
    else if (facts.gpu && SOFTWARE_GPU_RE.test(facts.gpu))
        scraper = 'Software renderer (headless browser)';
    else if (!jsRan && !facts.language) scraper = 'No Accept-Language header';
    else if (hosting && jsRan && facts.timezone && UTC_ZONES.has(facts.timezone.toLowerCase()))
        scraper = 'UTC clock on a hosting IP';
    else if (hosting && jsSkipped) scraper = 'Skipped JavaScript on a hosting IP';

    if (listed) return { vpn: listed, scraper };
    if (scraper || !hosting) return { vpn: null, scraper };
    // A hosting IP that doesn't look automated.
    if (host) return { vpn: `VPN host: ${host}`, scraper: null };
    if (jsRan) return { vpn: 'Browser on a hosting IP', scraper: null };
    return { vpn: null, scraper: null };
}

type Row = ClickFacts & { id: number; vpn: string | null; scraper: string | null };

const SELECT = `SELECT id, ts, ip, user_agent AS ua, is_bot, language, timezone, js, webdriver,
                       gpu, hostname, isp, is_datacenter, vpn, scraper
                FROM clicks`;
const BATCH = 5000;

export interface ClickClassifierOptions {
    lookup?: VpnLookup;
    now?: () => number;
}

/** Recomputes and stores `vpn` / `scraper` for clicks. */
export class ClickClassifier {
    readonly #db: Database;
    readonly #lookup: VpnLookup;
    readonly #now: () => number;
    readonly #byIds;
    readonly #byIp;
    readonly #after;
    readonly #update;

    constructor(db: Database, opts: ClickClassifierOptions = {}) {
        this.#db = db;
        this.#lookup = opts.lookup ?? (() => null);
        this.#now = opts.now ?? Date.now;
        this.#byIds = db.query<Row, [string]>(
            `${SELECT} WHERE id IN (SELECT value FROM json_each(?))`
        );
        this.#byIp = db.query<Row, [string]>(`${SELECT} WHERE ip = ?`);
        this.#after = db.query<Row, [number, number]>(`${SELECT} WHERE id > ? ORDER BY id LIMIT ?`);
        this.#update = db.query('UPDATE clicks SET vpn = ?, scraper = ? WHERE id = ?');
    }

    /** Classifies these clicks. Returns how many changed. */
    ids(ids: readonly number[]): number {
        if (ids.length === 0) return 0;
        return this.#apply(this.#byIds.all(JSON.stringify(ids)));
    }

    /** Classifies every click from this IP. */
    ip(ip: string): number {
        return this.#apply(this.#byIp.all(ip));
    }

    /** Classifies every click, a batch per transaction. */
    all(): number {
        let changed = 0;
        let last = 0;
        for (;;) {
            const rows = this.#after.all(last, BATCH);
            if (rows.length === 0) return changed;
            changed += this.#db.transaction(() => this.#apply(rows))();
            last = rows.at(-1)?.id ?? last;
        }
    }

    #apply(rows: Row[]): number {
        const now = this.#now();
        let changed = 0;
        for (const row of rows) {
            const { vpn, scraper } = classify(row, this.#lookup, now);
            if (vpn === row.vpn && scraper === row.scraper) continue;
            this.#update.run(vpn, scraper, row.id);
            changed++;
        }
        return changed;
    }
}
