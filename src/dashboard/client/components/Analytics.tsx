import { useEffect, useState } from 'react';

import type { TopRow } from '../../../shared/types.ts';
import { api, localTz } from '../api.ts';
import { useConfig } from '../config.tsx';
import { countryLabel, formatCount, formatDelta } from '../format.ts';
import { useApi } from '../useApi.ts';
import { Chart } from './Chart.tsx';
import { ClickHistory, type Toggle } from './ClickHistory.tsx';
import { type Tab, TopList } from './TopList.tsx';

const DAY = 86_400_000;
/** The search applies this long after typing stops. */
const SEARCH_DELAY_MS = 300;

const PRESETS = [
    { id: '24h', label: 'Last 24 hours', ms: DAY },
    { id: '7d', label: 'Last 7 days', ms: 7 * DAY },
    { id: '30d', label: 'Last 30 days', ms: 30 * DAY },
    { id: '90d', label: 'Last 90 days', ms: 90 * DAY },
    { id: '12mo', label: 'Last 12 months', ms: 365 * DAY }
] as const;

type PresetId = (typeof PRESETS)[number]['id'];

interface Filter {
    dim: string;
    /** Display text. */
    label: string;
    /** Value sent to the API as `dim:value`. */
    value: string;
}

const DIM_NAMES: Record<string, string> = {
    link: 'Link',
    country: 'Country',
    region: 'Region',
    city: 'City',
    referrer: 'Referrer',
    source: 'Source',
    os: 'OS',
    browser: 'Browser',
    device: 'Device',
    utm_source: 'utm_source',
    utm_medium: 'utm_medium',
    utm_campaign: 'utm_campaign',
    utm_term: 'utm_term',
    utm_content: 'utm_content',
    qr: 'Opened via',
    ip: 'IP',
    fingerprint: 'Device'
};

const PANELS: { title: string; tabs: Tab[]; drill?: boolean; linksOnly?: boolean }[] = [
    { title: 'Top links', tabs: [{ dim: 'link', label: 'Links' }], linksOnly: true },
    {
        title: 'Traffic',
        tabs: [
            { dim: 'source', label: 'Sources' },
            { dim: 'referrer', label: 'Referrers' }
        ]
    },
    {
        title: 'Location',
        tabs: [
            { dim: 'country', label: 'Countries' },
            { dim: 'region', label: 'Regions' },
            { dim: 'city', label: 'Cities' }
        ]
    },
    {
        title: 'Technology',
        tabs: [
            { dim: 'browser', label: 'Browsers' },
            { dim: 'os', label: 'OS' },
            { dim: 'device', label: 'Devices' },
            { dim: 'fingerprint', label: 'Fingerprints' }
        ]
    },
    {
        title: 'UTM',
        tabs: [
            { dim: 'utm_source', label: 'Source' },
            { dim: 'utm_medium', label: 'Medium' },
            { dim: 'utm_campaign', label: 'Campaign' },
            { dim: 'utm_term', label: 'Term' },
            { dim: 'utm_content', label: 'Content' }
        ]
    },
    { title: 'Query params', tabs: [{ dim: 'param', label: 'Keys' }], drill: true },
    { title: 'QR codes vs links', tabs: [{ dim: 'qr', label: 'Opened via' }] }
];

function filterFor(dim: string, row: TopRow): Filter {
    const value = row.value ?? '';
    if (dim.startsWith('param:')) {
        const key = dim.slice('param:'.length);
        return { dim: `param:${key}`, label: `?${key}=${value}`, value: `param:${key}=${value}` };
    }
    const shown =
        dim === 'country' && row.value
            ? countryLabel(row.value)
            : dim === 'fingerprint' && row.value
              ? row.value.slice(0, 10)
              : row.label;
    return { dim, label: `${DIM_NAMES[dim] ?? dim}: ${shown}`, value: `${dim}:${value}` };
}

function statsParams(opts: {
    preset: PresetId;
    filters: Filter[];
    bots: boolean;
    dc: boolean;
    scrapers: boolean;
    vpn: boolean;
    abusive: boolean;
    search: string;
    linkId?: number;
    now: number;
}): URLSearchParams {
    const ms = PRESETS.find(p => p.id === opts.preset)?.ms ?? 7 * DAY;
    // Round `to` up to the minute so the key (and the cache) is stable within a minute.
    const to = Math.ceil(opts.now / 60_000) * 60_000;
    const params = new URLSearchParams({
        from: String(to - ms),
        to: String(to),
        tz: String(localTz())
    });
    if (opts.linkId !== undefined) params.set('link', String(opts.linkId));
    if (opts.bots) params.set('bots', '1');
    if (opts.dc) params.set('dc', '1');
    if (opts.scrapers) params.set('scrapers', '1');
    if (!opts.vpn) params.set('vpn', '0');
    if (opts.abusive) params.set('abusive', '1');
    for (const f of opts.filters) params.append('f', f.value);
    if (opts.search) params.set('q', opts.search);
    return params;
}

interface AnalyticsProps {
    linkId?: number;
}

export function Analytics({ linkId }: AnalyticsProps) {
    const [preset, setPreset] = useState<PresetId>('30d');
    const [filters, setFilters] = useState<Filter[]>([]);
    const [bots, setBots] = useState(false);
    const [dc, setDc] = useState(false);
    const [scrapers, setScrapers] = useState(false);
    // VPN users are people, so they're counted unless unticked.
    const [vpn, setVpn] = useState(true);
    const [abusive, setAbusive] = useState(false);
    const { reputation } = useConfig();
    // What's in the search box, and the search applied to the page.
    const [text, setText] = useState('');
    const [search, setSearch] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setSearch(text.trim()), SEARCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, [text]);
    const applySearch = (next: string) => {
        setText(next);
        setSearch(next.trim());
    };
    const addTerm = (term: string) => {
        if (text.split(/\s+/).includes(term)) return;
        applySearch(`${text.trim()} ${term}`.trim());
    };
    // Bumped every 30 s so open dashboards stay current.
    const [tick, setTick] = useState(0);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(Date.now());
            setTick(t => t + 1);
        }, 30_000);
        return () => clearInterval(timer);
    }, []);

    const params = statsParams({
        preset,
        filters,
        bots,
        dc,
        scrapers,
        vpn,
        abusive,
        search,
        linkId,
        now
    });
    const key = `${tick}|${params}`;
    const summary = useApi(`summary|${key}`, () => api.summary(params));
    const series = useApi(`series|${key}`, () => api.timeseries(params));

    const addFilter = (dim: string, row: TopRow) => {
        if (dim === 'link' && linkId !== undefined) return;
        const filter = filterFor(dim, row);
        setFilters(current =>
            current.some(f => f.value === filter.value) ? current : [...current, filter]
        );
    };

    const toggles: Toggle[] = [
        { label: 'Bots', on: bots, set: setBots },
        { label: 'Scrapers', on: scrapers, set: setScrapers },
        { label: 'Datacenter IPs', on: dc, set: setDc },
        { label: 'VPN / relay', on: vpn, set: setVpn },
        ...(reputation ? [{ label: 'Abusive IPs', on: abusive, set: setAbusive }] : [])
    ];

    const exportUrl = `/api/export.csv?${params}`;
    const s = summary.data;

    return (
        <div className="analytics">
            <div className="filter-bar">
                <label className="field-inline">
                    <span className="visually-hidden">Date range</span>
                    <select value={preset} onChange={e => setPreset(e.target.value as PresetId)}>
                        {PRESETS.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={bots}
                        onChange={e => setBots(e.target.checked)}
                    />
                    Include bots
                </label>
                <label
                    className="checkbox"
                    title="Scripts and headless browsers that don't say they're bots"
                >
                    <input
                        type="checkbox"
                        checked={scrapers}
                        onChange={e => setScrapers(e.target.checked)}
                    />
                    Include scrapers
                </label>
                <label className="checkbox">
                    <input type="checkbox" checked={dc} onChange={e => setDc(e.target.checked)} />
                    Include datacenter IPs
                </label>
                <label
                    className="checkbox"
                    title="People on a VPN, Tor, iCloud Private Relay or Cloudflare WARP"
                >
                    <input type="checkbox" checked={vpn} onChange={e => setVpn(e.target.checked)} />
                    Include VPN / relay
                </label>
                {reputation && (
                    <label className="checkbox">
                        <input
                            type="checkbox"
                            checked={abusive}
                            onChange={e => setAbusive(e.target.checked)}
                        />
                        Include abusive IPs
                    </label>
                )}
                <ul className="chips" aria-label="Active filters">
                    {search && (
                        <li>
                            <button
                                type="button"
                                className="chip mono"
                                aria-label={`Clear search ${search}`}
                                onClick={() => applySearch('')}
                            >
                                Search: {search}
                                <span aria-hidden="true">×</span>
                            </button>
                        </li>
                    )}
                    {filters.map(f => (
                        <li key={f.value}>
                            <button
                                type="button"
                                className="chip"
                                aria-label={`Remove filter ${f.label}`}
                                onClick={() =>
                                    setFilters(current => current.filter(c => c.value !== f.value))
                                }
                            >
                                {f.label}
                                <span aria-hidden="true">×</span>
                            </button>
                        </li>
                    ))}
                </ul>
                <a className="text-button export" href={exportUrl} download>
                    Export CSV
                </a>
            </div>

            <div className="totals">
                <Total label="Clicks" value={s?.clicks} previous={s?.previous.clicks} />
                <Total
                    label="Unique visitors"
                    value={s?.visitors}
                    previous={s?.previous.visitors}
                />
            </div>
            {summary.error && <p className="error">{summary.error.message}</p>}

            {series.data && <Chart data={series.data} />}

            <div className="panels">
                {PANELS.filter(p => !(p.linksOnly && linkId !== undefined)).map(panel => (
                    <TopList
                        key={panel.title}
                        title={panel.title}
                        tabs={panel.tabs}
                        params={params}
                        refreshKey={String(tick)}
                        drill={panel.drill}
                        onSelect={addFilter}
                    />
                ))}
            </div>

            <ClickHistory
                params={params}
                refreshKey={String(tick)}
                showLink={linkId === undefined}
                toggles={toggles}
                text={text}
                onText={setText}
                search={search}
                onSearch={applySearch}
                onAddTerm={addTerm}
            />
        </div>
    );
}

function Total({ label, value, previous }: { label: string; value?: number; previous?: number }) {
    const delta =
        value === undefined || previous === undefined ? null : formatDelta(value, previous);
    return (
        <div className="total">
            <span className="total-label">{label}</span>
            <span className="total-value">{value === undefined ? '–' : formatCount(value)}</span>
            {delta && <span className="total-delta">{delta} vs previous period</span>}
        </div>
    );
}
