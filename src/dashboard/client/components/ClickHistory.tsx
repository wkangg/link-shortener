import { Fragment, useEffect, useState } from 'react';

import { isPrivateIp } from '../../../shared/ip.ts';
import type { ClickHistoryRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useConfig } from '../config.tsx';
import {
    countryLabel,
    formatCount,
    formatDateTime,
    formatRelative,
    gpuName,
    screenLabel
} from '../format.ts';
import { useApi } from '../useApi.ts';
import { clickSyntax, exactTerm, SearchBox } from './SearchBox.tsx';

/** "All" still pages, just in very large pages, so a huge history can't freeze the tab. */
const ALL = 10_000;
const PAGE_SIZES = [
    { value: 25, label: '25' },
    { value: 50, label: '50' },
    { value: 100, label: '100' },
    { value: 250, label: '250' },
    { value: ALL, label: 'All' }
] as const;
const DEFAULT_SIZE = 50;
const SIZE_KEY = 'clickHistory.pageSize';

/** Remembered per browser; storage can be unavailable (private windows, blocked storage). */
function savedSize(): number {
    try {
        const saved = Number(localStorage.getItem(SIZE_KEY));
        return PAGE_SIZES.some(s => s.value === saved) ? saved : DEFAULT_SIZE;
    } catch {
        return DEFAULT_SIZE;
    }
}

function saveSize(size: number): void {
    try {
        localStorage.setItem(SIZE_KEY, String(size));
    } catch {
        // Not remembered; still applies for this session.
    }
}

/** One of the dashboard's include toggles, mirrored here so it's reachable without scrolling up. */
export interface Toggle {
    label: string;
    on: boolean;
    set: (on: boolean) => void;
}

interface ClickHistoryProps {
    /** Stats query params (range, link, filters, bots). */
    params: URLSearchParams;
    refreshKey: string;
    /** Hide the link column on a single link's page. */
    showLink: boolean;
    toggles: Toggle[];
    /** The search box text, and the search applied to the whole page. */
    text: string;
    onText: (text: string) => void;
    search: string;
    /** Apply a search now. */
    onSearch: (search: string) => void;
    /** Add a term (e.g. `ip:=1.2.3.4`) to the search. */
    onAddTerm: (term: string) => void;
}

/** City and region, e.g. "Toronto, Ontario". */
function place(c: ClickHistoryRow): string {
    return [c.city, c.region].filter(Boolean).join(', ');
}

/**
 * Browser, OS and device, e.g. ["Edge", "Windows 11", "desktop"]. The browser-reported
 * platform wins over the user agent's OS: it can tell Windows 11 from 10.
 */
function technology(c: ClickHistoryRow): (string | null)[] {
    const os = c.platform ?? [c.os, c.osVersion].filter(Boolean).join(' ');
    return [c.browser, os, c.deviceModel ?? c.device];
}

/** Memory, CPU cores, touch, battery and connection, as reported by the browser. */
function specs(c: ClickHistoryRow): (string | null)[] {
    return [
        c.memory === null ? null : `${c.memory} GB RAM`,
        c.cpuCores === null ? null : `${c.cpuCores} ${c.cpuCores === 1 ? 'core' : 'cores'}`,
        c.touchPoints === null ? null : c.touchPoints > 0 ? 'touch' : 'no touch',
        c.battery === null ? null : `${c.battery}% battery`,
        c.charging ? 'charging' : null,
        c.connection
    ];
}

/**
 * Items separated by middots. Each item is an inline block, so lines break between items,
 * and an item wider than the column wraps inside itself instead of widening the table.
 */
function Dotted({ items }: { items: (string | null | undefined)[] }) {
    return items
        .filter((item): item is string => Boolean(item))
        .map((item, i) => (
            <Fragment key={item}>
                {i > 0 && ' · '}
                <span className="dotted-item">{item}</span>
            </Fragment>
        ));
}

/** Approximate coordinates of the IP, e.g. "43.65, -79.38". */
function coordinates(c: ClickHistoryRow): string {
    if (c.latitude === null || c.longitude === null) return '';
    return `${c.latitude.toFixed(2)}, ${c.longitude.toFixed(2)}`;
}

/** An IP-info page (ISP, organisation, ASN) for an address, opened in a new tab. */
function ipLookupUrl(ip: string): string {
    return `https://ipinfo.io/${encodeURIComponent(ip)}`;
}

/** AbuseIPDB's report page for an address. */
function abuseReportUrl(ip: string): string {
    return `https://www.abuseipdb.com/check/${encodeURIComponent(ip)}`;
}

/** IPv6 addresses may wrap after a colon; IPv4 has no break points and stays on one line. */
function breakableIp(ip: string) {
    // Each group plus its colon, keyed by where it ends in the address.
    const groups = ip.match(/[^:]*:?/g)?.filter(Boolean) ?? [ip];
    let end = 0;
    return groups.map(group => {
        end += group.length;
        return (
            <Fragment key={end}>
                {group}
                {group.endsWith(':') && <wbr />}
            </Fragment>
        );
    });
}

/** Search help: what to type, and what it matches. Lists of field names aren't runnable. */
const SEARCH_HELP: [string, string, runnable?: false][] = [
    ['firefox', 'any field contains “firefox”'],
    ['"new york"', 'a phrase'],
    ['ip:203.0.113 isp:comcast', 'a field contains a value'],
    ['ip:=203.0.113.5', 'a field is exactly a value (clicking a cell or bar adds one)'],
    ['os: browser: device: model: ua: bot:', 'technology', false],
    ['country: region: city: host: lang: tz:', 'location', false],
    ['source: referrer: link: utm: query:', 'traffic', false],
    ['gpu: screen: platform: connection: fp:', 'hardware', false],
    ['ram:>=8 battery:<20 touch:0 abuse:>50', 'numbers (=, >, >=, <, <=)'],
    ['is:bot is:scraper is:datacenter is:vpn is:abusive', 'overrides the toggles above'],
    ['vpn:tor scraper:', 'which VPN, or why a click looks automated'],
    ['is:private is:adblock is:qr is:mobile', 'other flags'],
    ['has:gpu', 'the field is set'],
    ['query.ref:=twitter', 'a query parameter (?ref=twitter)'],
    ['-os:windows -is:bot', 'a leading - excludes'],
    ['country:=CA country:=US is:qr', 'the same field twice: either; different fields: both'],
    ['os:ios || isp:rogers', 'either matches'],
    ['utm:spring && utm:launch', 'both, even on the same field'],
    ['(os:ios || isp:rogers) is:qr', 'brackets group'],
    ['-(is:mobile is:private)', 'excludes a whole group']
];

/** Short badge text for a VPN verdict: the service when it's a named one. */
function vpnBadge(vpn: string): string {
    if (vpn === 'Tor') return 'tor';
    if (vpn === 'iCloud Private Relay') return 'private relay';
    if (vpn === 'Cloudflare WARP') return 'warp';
    return 'vpn';
}

interface IpCellProps {
    ip: string;
    isDatacenter: boolean;
    vpn: string | null;
    scraper: string | null;
    /** AbuseIPDB abuse confidence, or null when not checked. */
    abuseScore: number | null;
    isp: string | null;
    onAddTerm: (term: string) => void;
}

/** An IP address: a filter button, an external ISP lookup, and a datacenter badge. */
function IpCell({ ip, isDatacenter, vpn, scraper, abuseScore, isp, onAddTerm }: IpCellProps) {
    const { abuseMinScore } = useConfig();
    const reported = abuseScore !== null && abuseScore > 0;
    const abusive = reported && abuseScore >= abuseMinScore;
    return (
        <span className="ip-cell">
            <button
                type="button"
                className="cell-filter"
                title="Search for this IP address"
                onClick={() => onAddTerm(exactTerm('ip', ip))}
            >
                {breakableIp(ip)}
            </button>
            {/* Lookup sites know nothing about local and private-network addresses. */}
            {!isPrivateIp(ip) && (
                <>
                    <a
                        className="ip-lookup"
                        href={ipLookupUrl(ip)}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Look up ISP and location (ipinfo.io)"
                        aria-label="Look up this IP address"
                    >
                        ↗
                    </a>
                    <a
                        className="ip-lookup"
                        href={abuseReportUrl(ip)}
                        target="_blank"
                        rel="noreferrer noopener"
                        title="Check abuse reports (AbuseIPDB)"
                        aria-label="Check abuse reports for this IP address"
                    >
                        ⚑
                    </a>
                </>
            )}
            {vpn ? (
                <button
                    type="button"
                    className="badge"
                    title={`VPN / relay: ${vpn}`}
                    onClick={() => onAddTerm(exactTerm('vpn', vpn))}
                >
                    {vpnBadge(vpn)}
                </button>
            ) : (
                isDatacenter && (
                    <span className="badge" title="Hosting / datacenter IP">
                        datacenter
                    </span>
                )
            )}
            {scraper && (
                <button
                    type="button"
                    className="badge badge-danger"
                    title={`Looks automated: ${scraper}`}
                    onClick={() => onAddTerm('is:scraper')}
                >
                    scraper
                </button>
            )}
            {reported && (
                <a
                    className={abusive ? 'badge badge-danger' : 'badge'}
                    href={abuseReportUrl(ip)}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`AbuseIPDB abuse confidence ${abuseScore}%`}
                >
                    {abusive ? 'abusive' : 'reported'} {abuseScore}%
                </a>
            )}
            {isp && (
                <span className="history-sub">
                    <button
                        type="button"
                        className="cell-filter"
                        title={`Search for ${isp}`}
                        onClick={() => onAddTerm(exactTerm('isp', isp))}
                    >
                        {isp}
                    </button>
                </span>
            )}
        </span>
    );
}

export function ClickHistory({
    params,
    refreshKey,
    showLink,
    toggles,
    text,
    onText,
    search,
    onSearch,
    onAddTerm
}: ClickHistoryProps) {
    const [showHelp, setShowHelp] = useState(false);

    // Re-render each minute so "3 minutes ago" doesn't go stale.
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(id);
    }, []);

    // Back to the first page whenever the range, filters, toggles or search change.
    const base = String(params);
    const [paging, setPaging] = useState({ base, page: 0 });
    const [size, setSize] = useState(savedSize);
    const requested = paging.base === base ? paging.page : 0;

    const syntax = clickSyntax(params);
    const query = new URLSearchParams(params);
    query.set('limit', String(size));
    query.set('offset', String(requested * size));
    const { data, error, loading } = useApi(`clicks|${refreshKey}|${query}`, () =>
        api.clicks(query)
    );
    const clicks = data?.clicks ?? [];
    const total = data?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(requested, pages - 1);
    // Asked for a page past the end (clicks aged out of the range): fetch the last real one.
    // Adjusting state while rendering is React's recommended alternative to an effect here.
    if (data && requested > pages - 1) setPaging({ base, page: pages - 1 });
    const goTo = (next: number) =>
        setPaging({ base, page: Math.min(Math.max(next, 0), pages - 1) });
    const first = page * size + 1;
    const last = page * size + clicks.length;
    const count = data && {
        label: `${formatCount(total)} ${search ? (total === 1 ? 'result' : 'results') : total === 1 ? 'click' : 'clicks'}`,
        stale: loading
    };
    const changeSize = (next: number) => {
        // Stay on the page that contains the first row currently shown.
        setPaging({ base, page: Math.floor((page * size) / next) });
        setSize(next);
        saveSize(next);
    };

    return (
        <section className="panel history" aria-label="Click history">
            <header className="panel-header">
                <h3>Click history</h3>
            </header>
            <form
                className="history-search"
                role="search"
                onSubmit={e => {
                    e.preventDefault();
                    onSearch(text);
                }}
            >
                <SearchBox
                    value={text}
                    onChange={onText}
                    onCommit={onSearch}
                    syntax={syntax}
                    count={count}
                />
                <button
                    type="button"
                    className="text-button"
                    aria-expanded={showHelp}
                    onClick={() => setShowHelp(v => !v)}
                >
                    Syntax
                </button>
                <ul className="chips" aria-label="Include">
                    {toggles.map(t => (
                        <li key={t.label}>
                            <button
                                type="button"
                                className="chip"
                                aria-pressed={t.on}
                                onClick={() => t.set(!t.on)}
                            >
                                {t.label}
                            </button>
                        </li>
                    ))}
                </ul>
            </form>
            {showHelp && (
                <dl className="search-help">
                    {SEARCH_HELP.map(([example, meaning, runnable]) => (
                        <Fragment key={example}>
                            <dt>
                                {runnable === false ? (
                                    <span className="mono">{example}</span>
                                ) : (
                                    <button
                                        type="button"
                                        className="cell-filter mono"
                                        title="Use this example"
                                        onClick={() => {
                                            onText(example);
                                            onSearch(example);
                                        }}
                                    >
                                        {example}
                                    </button>
                                )}
                            </dt>
                            <dd>{meaning}</dd>
                        </Fragment>
                    ))}
                </dl>
            )}
            {error && (
                <p className="panel-empty">
                    {search ? error.message : `Couldn’t load: ${error.message}`}
                </p>
            )}
            {!error && data && total === 0 && (
                <p className="panel-empty">{search ? 'No clicks match' : 'Nothing yet'}</p>
            )}
            {clicks.length > 0 && (
                <div className="history-scroll">
                    <table className="history-table">
                        <thead>
                            <tr>
                                <th scope="col">Time</th>
                                {showLink && <th scope="col">Link</th>}
                                <th scope="col">IP address</th>
                                <th scope="col">Location</th>
                                <th scope="col">Source</th>
                                <th scope="col">Device</th>
                                <th scope="col">Browser</th>
                            </tr>
                        </thead>
                        <tbody>
                            {clicks.map(c => (
                                <tr key={c.id}>
                                    <td className="nowrap" title={new Date(c.ts).toISOString()}>
                                        {formatDateTime(c.ts)}
                                        <div className="history-ago">
                                            {formatRelative(c.ts, now)}
                                        </div>
                                    </td>
                                    {showLink && (
                                        <td className="mono">
                                            {c.slug === null ? (
                                                <span className="muted">deleted</span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="cell-filter"
                                                    title="Search for this link"
                                                    onClick={() =>
                                                        onAddTerm(
                                                            exactTerm(
                                                                'link',
                                                                c.slug === '' ? '/' : (c.slug ?? '')
                                                            )
                                                        )
                                                    }
                                                >
                                                    {c.slug === '' ? '/' : c.slug}
                                                </button>
                                            )}
                                        </td>
                                    )}
                                    <td className="mono">
                                        {c.ip === null ? (
                                            <span className="muted">–</span>
                                        ) : (
                                            <IpCell
                                                ip={c.ip}
                                                isDatacenter={c.isDatacenter}
                                                vpn={c.vpn}
                                                scraper={c.scraper}
                                                abuseScore={c.abuseScore}
                                                isp={c.isp}
                                                onAddTerm={onAddTerm}
                                            />
                                        )}
                                    </td>
                                    <td className="history-location">
                                        {place(c) ||
                                            (c.country ? countryLabel(c.country) : null) || (
                                                <span className="muted">–</span>
                                            )}
                                        <span className="history-sub">
                                            <Dotted
                                                items={[
                                                    place(c) && c.country
                                                        ? countryLabel(c.country)
                                                        : null,
                                                    c.timezone,
                                                    c.language
                                                ]}
                                            />
                                        </span>
                                        {coordinates(c) && (
                                            <span
                                                className="history-sub numeric"
                                                title="Approximate, from the IP address"
                                            >
                                                {coordinates(c)}
                                            </span>
                                        )}
                                        {c.hostname && (
                                            <span className="history-sub">{c.hostname}</span>
                                        )}
                                    </td>
                                    <td className="history-source">
                                        {c.source}
                                        {c.referrer && (
                                            <span className="history-sub">{c.referrer}</span>
                                        )}
                                    </td>
                                    <td className="history-device">
                                        {c.screen ? (
                                            <span
                                                title={
                                                    c.orientation
                                                        ? `${c.orientation.split('-')[0]} screen`
                                                        : undefined
                                                }
                                            >
                                                {screenLabel(c.screen)}
                                            </span>
                                        ) : (
                                            <span className="muted">–</span>
                                        )}
                                        <span className="history-sub">
                                            <Dotted items={specs(c)} />
                                        </span>
                                        {c.gpu && (
                                            <span className="history-sub" title={c.gpu}>
                                                {gpuName(c.gpu)}
                                            </span>
                                        )}
                                        {(c.incognito || c.adBlocker || c.fingerprint) && (
                                            <span className="history-tags">
                                                {c.incognito && (
                                                    <span className="badge">private</span>
                                                )}
                                                {c.adBlocker && (
                                                    <span className="badge">ad blocker</span>
                                                )}
                                                {c.fingerprint && (
                                                    <button
                                                        type="button"
                                                        className="cell-filter mono"
                                                        title="Search for this device fingerprint"
                                                        onClick={() =>
                                                            onAddTerm(
                                                                exactTerm('fp', c.fingerprint ?? '')
                                                            )
                                                        }
                                                    >
                                                        ⚷ {c.fingerprint.slice(0, 10)}
                                                    </button>
                                                )}
                                            </span>
                                        )}
                                    </td>
                                    <td className="history-ua">
                                        {technology(c).some(Boolean) ? (
                                            <Dotted items={technology(c)} />
                                        ) : (
                                            'Unknown'
                                        )}
                                        {c.bot && (
                                            <span className="badge">
                                                {c.botName ? `bot: ${c.botName}` : 'bot'}
                                            </span>
                                        )}
                                        {c.userAgent && (
                                            <details className="history-raw">
                                                <summary>User agent</summary>
                                                <span className="mono">{c.userAgent}</span>
                                            </details>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {total > 0 && clicks.length > 0 && (
                <nav className="pager" aria-label="Click history pages">
                    <div className="pager-info">
                        <span className="pager-range">
                            {formatCount(first)}–{formatCount(last)} of {formatCount(total)}
                        </span>
                        <label className="pager-size">
                            Per page
                            <select value={size} onChange={e => changeSize(Number(e.target.value))}>
                                {PAGE_SIZES.map(s => (
                                    <option key={s.value} value={s.value}>
                                        {s.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {pages > 1 && (
                        <div className="pager-buttons">
                            <button
                                type="button"
                                className="button small"
                                disabled={page === 0 || loading}
                                onClick={() => goTo(0)}
                                aria-label="Newest page"
                            >
                                «
                            </button>
                            <button
                                type="button"
                                className="button small"
                                disabled={page === 0 || loading}
                                onClick={() => goTo(page - 1)}
                            >
                                Newer
                            </button>
                            <span className="pager-page">
                                Page {formatCount(page + 1)} of {formatCount(pages)}
                            </span>
                            <button
                                type="button"
                                className="button small"
                                disabled={page >= pages - 1 || loading}
                                onClick={() => goTo(page + 1)}
                            >
                                Older
                            </button>
                            <button
                                type="button"
                                className="button small"
                                disabled={page >= pages - 1 || loading}
                                onClick={() => goTo(pages - 1)}
                                aria-label="Oldest page"
                            >
                                »
                            </button>
                        </div>
                    )}
                </nav>
            )}
        </section>
    );
}
