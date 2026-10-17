import { z } from 'zod/v4';

const port = z.coerce.number().int().min(0).max(65535);
const origin = z.url({ protocol: /^https?$/ }).transform(s => s.replace(/\/+$/, ''));

const schema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    SHORT_PORT: port.default(3000),
    DASH_PORT: port.default(3001),
    SHORT_ORIGIN: origin.optional(),
    DASH_ORIGIN: origin.optional(),
    DB_PATH: z.string().min(1).default('./data/links.db'),
    CF_ACCESS_TEAM_DOMAIN: z.string().min(1).optional(),
    CF_ACCESS_AUD: z.string().min(1).optional(),
    VISITOR_SALT: z.string().min(16).optional(),
    ABUSEIPDB_API_KEY: z.string().min(1).optional(),
    ABUSEIPDB_MIN_SCORE: z.coerce.number().int().min(1).max(100).default(25),
    ABUSEIPDB_DAILY_LIMIT: z.coerce.number().int().min(1).default(1000)
});

export interface Config {
    env: 'development' | 'production' | 'test';
    isProd: boolean;
    shortPort: number;
    dashPort: number;
    /** Public origin of the short-link domain, no trailing slash (e.g. https://s.example). */
    shortOrigin: string;
    /** Public origin of the dashboard, no trailing slash (e.g. https://dash.example). */
    dashOrigin: string;
    dbPath: string;
    cfAccess: { teamDomain: string; aud: string } | null;
    /** Secret mixed into the visitor hash. Random per process when unset. */
    visitorSalt: string;
    /** AbuseIPDB reputation lookups; null when no API key is set. */
    abuseIpdb: { apiKey: string; dailyLimit: number } | null;
    /** Clicks from IPs with an abuse confidence score at or above this are hidden by default. */
    abuseMinScore: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
    // Treat empty strings (common in container platforms and .env files) as unset.
    const cleaned = Object.fromEntries(
        Object.entries(env).filter(([, v]) => v !== undefined && v !== '')
    );
    const parsed = schema.safeParse(cleaned);
    if (!parsed.success) {
        throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
    }
    const e = parsed.data;
    const isProd = e.NODE_ENV === 'production';

    if (e.SHORT_PORT !== 0 && e.SHORT_PORT === e.DASH_PORT) {
        throw new Error('Invalid environment configuration: SHORT_PORT and DASH_PORT must differ');
    }
    if (Boolean(e.CF_ACCESS_TEAM_DOMAIN) !== Boolean(e.CF_ACCESS_AUD)) {
        throw new Error(
            'Invalid environment configuration: set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither'
        );
    }
    if (isProd && (!e.SHORT_ORIGIN || !e.DASH_ORIGIN)) {
        throw new Error(
            'Invalid environment configuration: SHORT_ORIGIN and DASH_ORIGIN are required in production'
        );
    }
    if (isProd && !e.CF_ACCESS_TEAM_DOMAIN) {
        throw new Error(
            'Invalid environment configuration: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required in production (the dashboard API would otherwise be unauthenticated)'
        );
    }

    return {
        env: e.NODE_ENV,
        isProd,
        shortPort: e.SHORT_PORT,
        dashPort: e.DASH_PORT,
        shortOrigin: e.SHORT_ORIGIN ?? `http://localhost:${e.SHORT_PORT}`,
        dashOrigin: e.DASH_ORIGIN ?? `http://localhost:${e.DASH_PORT}`,
        dbPath: e.DB_PATH,
        cfAccess:
            e.CF_ACCESS_TEAM_DOMAIN && e.CF_ACCESS_AUD
                ? { teamDomain: e.CF_ACCESS_TEAM_DOMAIN, aud: e.CF_ACCESS_AUD }
                : null,
        visitorSalt: e.VISITOR_SALT ?? crypto.randomUUID(),
        abuseIpdb: e.ABUSEIPDB_API_KEY
            ? { apiKey: e.ABUSEIPDB_API_KEY, dailyLimit: e.ABUSEIPDB_DAILY_LIMIT }
            : null,
        abuseMinScore: e.ABUSEIPDB_MIN_SCORE
    };
}
