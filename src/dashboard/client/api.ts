import type {
    AboutResponse,
    ApiError,
    ClickHistoryResponse,
    ConfigResponse,
    Link,
    LinkListResponse,
    RedirectType,
    SuggestResponse,
    SummaryResponse,
    TimeseriesResponse,
    TopResponse,
    TrackMode,
    WebhookEndpoint,
    WebhookEndpointCreated,
    WebhookEventRow,
    WebhookKind,
    WebhookSecretResponse,
    WebhookSkipCategory
} from '../../shared/types.ts';
import { forgetKept } from './useApi.ts';

export class ApiRequestError extends Error {
    readonly status: number;
    readonly issues: ApiError['issues'];

    constructor(status: number, body: ApiError) {
        super(body.error);
        this.name = 'ApiRequestError';
        this.status = status;
        this.issues = body.issues;
    }
}

async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
): Promise<T> {
    // A write may change data pages kept to show on return (useApi), even if it fails. Forget
    // it before (for loads already on their way) and after (for loads sent meanwhile).
    const write = method !== 'GET';
    if (write) forgetKept();
    const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
    }).finally(() => {
        if (write) forgetKept();
    });
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new ApiRequestError(res.status, data as ApiError);
    return data as T;
}

const getJson = <T>(path: string, signal?: AbortSignal) =>
    request<T>('GET', path, undefined, signal);

/** Requests for a refresh's panels still waiting for the server. */
let statsPending = 0;

/** Whether a stats request is still on its way, so Analytics doesn't pile a refresh on it. */
export const statsLoading = () => statsPending > 0;

function getStats<T>(path: string, signal?: AbortSignal): Promise<T> {
    statsPending++;
    return getJson<T>(path, signal).finally(() => {
        statsPending--;
    });
}

interface LinkInput {
    url: string;
    slug?: string;
    title?: string | null;
    redirectType?: RedirectType;
    expiresAt?: number | null;
    tags?: string[];
    archived?: boolean;
    trackDevice?: boolean;
    trackMode?: TrackMode;
}

interface WebhookInput {
    url: string;
    kind?: WebhookKind;
    description?: string | null;
    enabled?: boolean;
    allLinks?: boolean;
    /** Link ids. */
    links?: number[];
    tags?: string[];
    skip?: WebhookSkipCategory[];
    includeIp?: boolean;
}

export const api = {
    config: () => getJson<ConfigResponse>('/api/config'),
    about: () => getJson<AboutResponse>('/api/about'),
    links: (params: URLSearchParams) => getJson<LinkListResponse>(`/api/links?${params}`),
    link: (id: number) => getJson<Link>(`/api/links/${id}`),
    tags: () => getJson<{ tag: string; count: number }[]>('/api/tags'),
    createLink: (input: LinkInput) => request<Link>('POST', '/api/links', input),
    updateLink: (id: number, input: Partial<LinkInput>) =>
        request<Link>('PATCH', `/api/links/${id}`, input),
    deleteLink: (id: number) => request<undefined>('DELETE', `/api/links/${id}`),
    summary: (params: URLSearchParams, signal?: AbortSignal) =>
        getStats<SummaryResponse>(`/api/stats/summary?${params}`, signal),
    timeseries: (params: URLSearchParams, signal?: AbortSignal) =>
        getStats<TimeseriesResponse>(`/api/stats/timeseries?${params}`, signal),
    top: (params: URLSearchParams, signal?: AbortSignal) =>
        getStats<TopResponse>(`/api/stats/top?${params}`, signal),
    suggest: (params: URLSearchParams, signal?: AbortSignal) =>
        getJson<SuggestResponse>(`/api/stats/suggest?${params}`, signal),
    clicks: (params: URLSearchParams, signal?: AbortSignal) =>
        getStats<ClickHistoryResponse>(`/api/stats/clicks?${params}`, signal),
    webhooks: () => getJson<WebhookEndpoint[]>('/api/webhooks'),
    createWebhook: (input: WebhookInput) =>
        request<WebhookEndpointCreated>('POST', '/api/webhooks', input),
    updateWebhook: (id: number, input: Partial<Omit<WebhookInput, 'kind'>>) =>
        request<WebhookEndpoint>('PATCH', `/api/webhooks/${id}`, input),
    deleteWebhook: (id: number) => request<undefined>('DELETE', `/api/webhooks/${id}`),
    setWebhookLink: (id: number, linkId: number, on: boolean) =>
        request<WebhookEndpoint>(on ? 'PUT' : 'DELETE', `/api/webhooks/${id}/links/${linkId}`),
    rotateWebhookSecret: (id: number) =>
        request<WebhookSecretResponse>('POST', `/api/webhooks/${id}/secret`),
    testWebhook: (id: number) => request<WebhookEventRow>('POST', `/api/webhooks/${id}/test`),
    webhookEvents: (id: number) => getJson<WebhookEventRow[]>(`/api/webhooks/${id}/events`),
    retryWebhookEvent: (id: number) =>
        request<WebhookEventRow>('POST', `/api/webhook-events/${id}/retry`)
};

/**
 * The browser's time zone for day boundaries: its name, so days follow daylight
 * saving across a range, and today's offset for servers that don't know the name.
 */
export const localTime = () => ({
    tz: String(-new Date().getTimezoneOffset()),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone
});
