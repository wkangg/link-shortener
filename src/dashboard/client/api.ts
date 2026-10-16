import type {
    ApiError,
    ClickHistoryResponse,
    ConfigResponse,
    Link,
    LinkListResponse,
    RedirectType,
    SuggestResponse,
    SummaryResponse,
    TimeseriesResponse,
    TopResponse
} from '../../shared/types.ts';

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (res.status === 204) return undefined as T;
    const data: unknown = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new ApiRequestError(res.status, data as ApiError);
    return data as T;
}

export const getJson = <T>(path: string) => request<T>('GET', path);

export interface LinkInput {
    url: string;
    slug?: string;
    title?: string | null;
    redirectType?: RedirectType;
    expiresAt?: number | null;
    tags?: string[];
    archived?: boolean;
    trackDevice?: boolean;
}

export const api = {
    config: () => getJson<ConfigResponse>('/api/config'),
    links: (params: URLSearchParams) => getJson<LinkListResponse>(`/api/links?${params}`),
    link: (id: number) => getJson<Link>(`/api/links/${id}`),
    tags: () => getJson<{ tag: string; count: number }[]>('/api/tags'),
    createLink: (input: LinkInput) => request<Link>('POST', '/api/links', input),
    updateLink: (id: number, input: Partial<LinkInput>) =>
        request<Link>('PATCH', `/api/links/${id}`, input),
    deleteLink: (id: number) => request<undefined>('DELETE', `/api/links/${id}`),
    summary: (params: URLSearchParams) => getJson<SummaryResponse>(`/api/stats/summary?${params}`),
    timeseries: (params: URLSearchParams) =>
        getJson<TimeseriesResponse>(`/api/stats/timeseries?${params}`),
    top: (params: URLSearchParams) => getJson<TopResponse>(`/api/stats/top?${params}`),
    suggest: (params: URLSearchParams) => getJson<SuggestResponse>(`/api/stats/suggest?${params}`),
    clicks: (params: URLSearchParams) =>
        getJson<ClickHistoryResponse>(`/api/stats/clicks?${params}`)
};

/** Minutes to add to UTC to get local time. */
export const localTz = () => -new Date().getTimezoneOffset();
