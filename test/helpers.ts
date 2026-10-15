import { startApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Identity } from '../src/dashboard/auth.ts';
import { openDatabase } from '../src/db/client.ts';

export const DASH = 'https://dash.example';

/** Both servers on random ports, an in-memory database, and switchable auth. */
export function testApp() {
    const db = openDatabase(':memory:');
    const config = loadConfig({
        SHORT_PORT: '0',
        DASH_PORT: '0',
        SHORT_ORIGIN: 'https://s.example',
        DASH_ORIGIN: DASH,
        VISITOR_SALT: 'test-salt-test-salt'
    });
    const auth: { identity: Identity | null } = { identity: { subject: 'me@example.com' } };
    const app = startApp({
        config,
        db,
        version: 'test',
        authenticate: () => Promise.resolve(auth.identity),
        flushIntervalMs: 60_000
    });

    const api = (path: string, init: RequestInit = {}) =>
        fetch(new URL(path, app.dash.url), {
            ...init,
            headers: {
                ...(init.body !== undefined && {
                    'Content-Type': 'application/json',
                    Origin: DASH
                }),
                ...init.headers
            }
        });
    const click = (path: string, headers: Record<string, string> = {}) =>
        fetch(new URL(path, app.short.url), { redirect: 'manual', headers });

    /** Status code of a dashboard request. */
    const status = async (path: string, init?: RequestInit) => {
        const res = await api(path, init);
        return res.status;
    };
    /** Parsed JSON body of a dashboard GET. */
    const get = async <T>(path: string): Promise<T> => {
        const res = await api(path);
        return (await res.json()) as T;
    };

    return {
        app,
        status,
        get,
        db,
        auth,
        api,
        click,
        async close() {
            await app.stop();
            db.close();
        }
    };
}
