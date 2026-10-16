// Types shared between the server and the dashboard client. Must stay free of
// runtime imports (the client bundle and the redirect hot path both use it).

export interface HealthResponse {
    ok: boolean;
    version: string;
    db: boolean;
}

export interface ConfigResponse {
    shortOrigin: string;
    dashOrigin: string;
    version: string;
}

export type RedirectType = 301 | 302 | 307 | 308;

export interface Link {
    id: number;
    slug: string;
    url: string;
    title: string | null;
    redirectType: RedirectType;
    /** Unix ms, or null for never. */
    expiresAt: number | null;
    archived: boolean;
    tags: string[];
    createdAt: number;
    updatedAt: number;
}

export interface LinkWithStats extends Link {
    clicks: number;
    /** Clicks per day for the last 7 days, oldest first. */
    spark: number[];
}

export interface LinkListResponse {
    links: LinkWithStats[];
    total: number;
}

export interface ApiError {
    error: string;
    issues?: { path: string; message: string }[];
}

/** Dimensions the analytics API can group by and filter on. */
export const DIMENSIONS = [
    'link',
    'country',
    'region',
    'city',
    'referrer',
    'source',
    'os',
    'browser',
    'device',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'qr',
    'param',
    'ip'
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export interface StatsQuery {
    from: number;
    to: number;
    /** Minutes to add to UTC to get local time (e.g. -240 for Toronto in summer). */
    tz: number;
    link?: number;
    bots?: boolean;
    /** `dim:value`, or `param:key=value` / `param:key` for query params. */
    filters: string[];
}

export interface SummaryResponse {
    clicks: number;
    visitors: number;
    previous: { clicks: number; visitors: number };
}

export interface TimeseriesResponse {
    interval: 'hour' | 'day';
    /** Bucket start (unix ms, UTC), clicks, unique visitors. */
    points: { t: number; clicks: number; visitors: number }[];
}

export interface TopRow {
    /** Raw value used for filtering; null when the click had no value. */
    value: string | null;
    /** Display label (e.g. the slug for `link`). */
    label: string;
    clicks: number;
    visitors: number;
}

export interface TopResponse {
    dim: string;
    rows: TopRow[];
}

/** One click in the per-request history, newest first. */
export interface ClickHistoryRow {
    id: number;
    /** Unix ms. */
    ts: number;
    linkId: number;
    /** Null if the link was deleted. */
    slug: string | null;
    ip: string | null;
    userAgent: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    referrer: string | null;
    source: string;
    qr: boolean;
    device: string | null;
    browser: string | null;
    os: string | null;
    bot: boolean;
}

export interface ClickHistoryResponse {
    clicks: ClickHistoryRow[];
    /** Pass as `before` to get the next (older) page; null when there are no more. */
    next: string | null;
}

/** What the redirect handler records per click. Enriched later, off the hot path. */
export interface RawClick {
    linkId: number;
    ts: number;
    /** Destination URL at click time (for UTM fallback). */
    url: string;
    ip: string;
    ua: string;
    referrer: string;
    country: string;
    region: string;
    city: string;
    qr: boolean;
    /** Query string from the short URL, without the leading `?` and without `qr`. */
    query: string;
}

export interface ClickSink {
    push(click: RawClick): void;
}
