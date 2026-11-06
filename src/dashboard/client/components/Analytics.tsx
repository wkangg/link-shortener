import { useEffect, useState } from 'react';

import type { TopRow } from '../../../shared/types.ts';
import { api, localTz } from '../api.ts';
import { useConfig } from '../config.tsx';
import { formatCount, formatPercent, percentChange } from '../format.ts';
import { useApi } from '../useApi.ts';
import { useCountUp } from '../useCountUp.ts';
import { Chart } from './Chart.tsx';
import { ClickHistory, type Toggle } from './ClickHistory.tsx';
import { FilterChips } from './FilterChips.tsx';
import { exactTerm, hasTerm, toggleTerm, withTerm } from './SearchBox.tsx';
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

/** The search term that narrows to a panel row, e.g. `country:=CA` or `-has:utm_source`. */
function searchTerm(dim: string, row: TopRow): string {
    if (dim === 'qr') return row.value === 'QR' ? 'is:qr' : '-is:qr';
    // The label is the slug, with the root link as "/".
    if (dim === 'link') return exactTerm('link', row.label);
    const field = dim.startsWith('param:')
        ? `query.${dim.slice('param:'.length)}`
        : dim === 'fingerprint'
          ? 'fp'
          : dim;
    return row.value === null ? `-has:${field}` : exactTerm(field, row.value);
}

function statsParams(opts: {
    preset: PresetId;
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
    if (opts.search) params.set('q', opts.search);
    return params;
}

interface AnalyticsProps {
    linkId?: number;
}

export function Analytics({ linkId }: AnalyticsProps) {
    const [preset, setPreset] = useState<PresetId>('30d');
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
    const addTerm = (term: string) => applySearch(withTerm(text, term));
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

    const selectRow = (dim: string, row: TopRow) => {
        if (dim === 'link' && linkId !== undefined) return;
        // Clicking the row again takes its filter back off.
        applySearch(toggleTerm(text, searchTerm(dim, row)));
    };
    const isRowActive = (dim: string, row: TopRow) =>
        !(dim === 'link' && linkId !== undefined) && hasTerm(text, searchTerm(dim, row));

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
                <FilterChips search={search} onChange={applySearch} />
                <a className="text-button export" href={exportUrl} download>
                    Export CSV
                </a>
            </div>

            <div className="totals">
                <Total
                    label="Clicks"
                    value={s?.clicks}
                    previous={s?.previous?.clicks}
                    failed={summary.error !== undefined}
                />
                <Total
                    label="Unique visitors"
                    value={s?.visitors}
                    previous={s?.previous?.visitors}
                    failed={summary.error !== undefined}
                />
            </div>
            {summary.error && <p className="error">{summary.error.message}</p>}

            <Chart data={series.data} error={series.error} />

            <div className="panels">
                {PANELS.filter(p => !(p.linksOnly && linkId !== undefined)).map(panel => (
                    <TopList
                        key={panel.title}
                        title={panel.title}
                        tabs={panel.tabs}
                        params={params}
                        refreshKey={String(tick)}
                        drill={panel.drill}
                        onSelect={selectRow}
                        isActive={isRowActive}
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

interface TotalProps {
    label: string;
    value?: number;
    previous?: number;
    /** Show a dash rather than a 0 that would look like real data. */
    failed: boolean;
}

function Total({ label, value, previous, failed }: TotalProps) {
    // Counts up from 0 while the first load is in flight.
    const shown = useCountUp(value ?? 0);
    const loaded = value !== undefined && previous !== undefined;
    const pct = loaded ? percentChange(value, previous) : null;
    // Counts to the new change alongside the total, colored by the sign it shows.
    const shownPct = useCountUp(pct ?? 0);
    const isNew = loaded && previous === 0 && value > 0;
    const delta = isNew
        ? 'new'
        : pct === null
          ? null
          : pct === 0 && shownPct === 0
            ? 'no change'
            : formatPercent(shownPct);
    const trend = isNew || shownPct > 0 ? 'up' : shownPct < 0 ? 'down' : undefined;
    return (
        <div className="total">
            <span className="total-label">{label}</span>
            <span className="total-value">
                {failed && value === undefined ? '–' : formatCount(shown)}
            </span>
            <span className="total-delta">
                {delta && (
                    <>
                        <span className={trend}>{delta}</span>
                        <span className="total-delta-vs"> vs previous period</span>
                    </>
                )}
            </span>
        </div>
    );
}
