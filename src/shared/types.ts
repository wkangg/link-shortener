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
    /** AbuseIPDB lookups are on (ABUSEIPDB_API_KEY is set). */
    reputation: boolean;
    /** Abuse score at or above which a click's IP counts as reported. */
    abuseMinScore: number;
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
    /** Serve a JS page that reports browser-side signals before forwarding. */
    trackDevice: boolean;
    tags: string[];
    createdAt: number;
    updatedAt: number;
}

export interface LinkWithStats extends Link {
    clicks: number;
    /** Unique visitors (distinct visitor hashes). */
    visitors: number;
    /** Clicks per day for the last 7 days, oldest first. */
    spark: number[];
    /** Webhooks that get this link's clicks: for every link, chosen for it, or by tag. */
    webhooks: LinkWebhookRef[];
}

export interface LinkWebhookRef {
    id: number;
    /** The description, or "Discord" / the URL's host. */
    name: string;
    enabled: boolean;
    /** It's for every link, not chosen for this one. */
    allLinks: boolean;
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
    'ip',
    'fingerprint'
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export interface SuggestResponse {
    field: string;
    /** Most common first. */
    values: { value: string; clicks: number }[];
}

export interface StatsQuery {
    from: number;
    to: number;
    /** Minutes to add to UTC to get local time (e.g. -240 for Toronto in summer). */
    tz: number;
    link?: number;
    bots?: boolean;
    /** Include clicks from datacenter/hosting IPs (hidden by default, like bots). */
    dc?: boolean;
    /** Include clicks that look automated (hidden by default; see analytics/classify.ts). */
    scrapers?: boolean;
    /** Include clicks through a VPN or relay. Shown unless this is false. */
    vpn?: boolean;
    /** Include clicks from IPs reported for abuse (hidden by default). */
    abusive?: boolean;
    /** `dim:value`, or `param:key=value` / `param:key` for query params. */
    filters: string[];
    /** Search over click properties (see analytics/search.ts). */
    q?: string;
}

export interface SummaryResponse {
    clicks: number;
    visitors: number;
    /** The period of the same length just before; null if no link existed yet. */
    previous: { clicks: number; visitors: number } | null;
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
    /** e.g. "18.6"; iOS only for now. */
    osVersion: string | null;
    bot: boolean;
    botName: string | null;
    /** 1 when the IP belongs to a hosting/datacenter provider. */
    isDatacenter: boolean;
    /** The VPN or relay the click came through (e.g. "Tor"), or null. */
    vpn: string | null;
    /** Why the click looks automated, or null. */
    scraper: string | null;
    /** Coarse device fingerprint; groups clicks from the same device. */
    fingerprint: string | null;
    /** AbuseIPDB abuse confidence (0-100); null when not checked. */
    abuseScore: number | null;
    /** ISP of the IP, from AbuseIPDB. */
    isp: string | null;
    deviceModel: string | null;
    language: string | null;
    timezone: string | null;
    /** Reverse DNS of `ip`. */
    hostname: string | null;
    // Reported by the browser on links with trackDevice; null otherwise.
    screen: string | null;
    orientation: string | null;
    /** 0-100. */
    battery: number | null;
    charging: boolean | null;
    connection: string | null;
    gpu: string | null;
    incognito: boolean | null;
    adBlocker: boolean | null;
    /** Approximate (city-level) position of the IP, from the edge. */
    latitude: number | null;
    longitude: number | null;
    /** GB of RAM as rounded by the browser (Chromium only). */
    memory: number | null;
    /** Logical CPU cores (navigator.hardwareConcurrency). */
    cpuCores: number | null;
    /** e.g. "Windows 11" (Chromium only). */
    platform: string | null;
    /** Max simultaneous touches; 0 = no touch screen. */
    touchPoints: number | null;
}

export interface ClickHistoryResponse {
    clicks: ClickHistoryRow[];
    /** Pass as `before` to get the next (older) page; null when there are no more. */
    next: string | null;
    /** Clicks matching the query in total (all pages). */
    total: number;
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
    /** Accept-Language header. */
    language: string;
    /** CF-Timezone header. */
    timezone: string;
    /** CF-IPLatitude / CF-IPLongitude headers. */
    latitude: string;
    longitude: string;
    /** One-time id the device-signals page reports back with; null for plain redirects. */
    token: string | null;
}

export interface ClickSink {
    push(click: RawClick): void;
    /** Browser-side signals for the click with this token (raw, unvalidated JSON body). */
    pushSignals(token: string, body: string, ts: number): void;
}

export type WebhookKind = 'standard' | 'discord';

/** Click categories a webhook endpoint can choose not to receive. */
export const WEBHOOK_SKIP_CATEGORIES = ['bot', 'datacenter', 'scraper', 'abusive', 'vpn'] as const;

export type WebhookSkipCategory = (typeof WEBHOOK_SKIP_CATEGORIES)[number];

/** What a new endpoint skips: the traffic the dashboard hides by default. */
export const DEFAULT_WEBHOOK_SKIP: WebhookSkipCategory[] = [
    'bot',
    'datacenter',
    'scraper',
    'abusive'
];

/** The latest event an endpoint finished, for its status line. */
export interface WebhookLastEvent {
    status: 'delivered' | 'skipped' | 'failed';
    /** Unix ms. */
    at: number;
    /** HTTP status of the last attempt. */
    httpStatus: number | null;
    error: string | null;
}

export interface WebhookEndpoint {
    id: number;
    kind: WebhookKind;
    /** Discord URLs come back with the token hidden. */
    url: string;
    description: string | null;
    enabled: boolean;
    /** Clicks on every link; when false, only `links` and links tagged with one of `tags`. */
    allLinks: boolean;
    /** Links chosen for this endpoint (used when `allLinks` is false). */
    links: { id: number; slug: string }[];
    /** Links with one of these tags (used when `allLinks` is false). */
    tags: string[];
    skip: WebhookSkipCategory[];
    /** Send the visitor's IP address and user agent. */
    includeIp: boolean;
    /** Why it was turned off automatically, if it was. */
    disabledReason: string | null;
    /** Start of the current run of failures (unix ms), or null. */
    failingSince: number | null;
    /** Events by status, over the last 7 days for finished ones. */
    counts: { pending: number; delivered: number; skipped: number; failed: number };
    lastEvent: WebhookLastEvent | null;
    createdAt: number;
    updatedAt: number;
}

/** Returned once, on create and on rotating the secret. */
export interface WebhookSecretResponse {
    /** whsec_… for standard endpoints. */
    secret: string;
}

export interface WebhookEndpointCreated extends WebhookEndpoint {
    /** The signing secret, shown only now; null for Discord. */
    secret: string | null;
}

export interface WebhookEventRow {
    id: number;
    type: 'link.clicked' | 'webhook.test';
    clickId: number | null;
    /** The webhook-id header. */
    eventId: string;
    status: 'pending' | 'delivered' | 'skipped' | 'failed';
    attempts: number;
    httpStatus: number | null;
    error: string | null;
    /** Unix ms. */
    createdAt: number;
    /** Next attempt, for pending events. */
    dueAt: number;
    finishedAt: number | null;
}
