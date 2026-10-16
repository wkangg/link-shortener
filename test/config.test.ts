import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
    test('development defaults', () => {
        const c = loadConfig({});
        expect(c.env).toBe('development');
        expect(c.shortPort).toBe(3000);
        expect(c.dashPort).toBe(3001);
        expect(c.shortOrigin).toBe('http://localhost:3000');
        expect(c.dashOrigin).toBe('http://localhost:3001');
        expect(c.dbPath).toBe('./data/links.db');
        expect(c.cfAccess).toBeNull();
        expect(c.abuseIpdb).toBeNull();
        expect(c.abuseMinScore).toBe(25);
    });

    test('AbuseIPDB settings', () => {
        expect(
            loadConfig({
                ABUSEIPDB_API_KEY: 'k',
                ABUSEIPDB_MIN_SCORE: '50',
                ABUSEIPDB_DAILY_LIMIT: '5000'
            })
        ).toMatchObject({ abuseIpdb: { apiKey: 'k', dailyLimit: 5000 }, abuseMinScore: 50 });
        expect(loadConfig({ ABUSEIPDB_API_KEY: '' }).abuseIpdb).toBeNull();
        expect(() => loadConfig({ ABUSEIPDB_MIN_SCORE: '0' })).toThrow();
        expect(() => loadConfig({ ABUSEIPDB_MIN_SCORE: '101' })).toThrow();
    });

    test('production uses the configured domains', () => {
        const c = loadConfig({
            NODE_ENV: 'production',
            SHORT_ORIGIN: 'https://s.example',
            DASH_ORIGIN: 'https://dash.example',
            CF_ACCESS_TEAM_DOMAIN: 'me.cloudflareaccess.com',
            CF_ACCESS_AUD: 'aud'
        });
        expect(c.isProd).toBe(true);
        expect(c.shortOrigin).toBe('https://s.example');
        expect(c.dashOrigin).toBe('https://dash.example');
    });

    test('production requires its domains and Cloudflare Access', () => {
        expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ORIGIN.*required/);
        expect(() =>
            loadConfig({
                NODE_ENV: 'production',
                SHORT_ORIGIN: 'https://s.example',
                DASH_ORIGIN: 'https://dash.example'
            })
        ).toThrow(/CF_ACCESS.*required/);
    });

    test('visitor salt: explicit, or random per process', () => {
        expect(loadConfig({ VISITOR_SALT: 'a-long-enough-secret' }).visitorSalt).toBe(
            'a-long-enough-secret'
        );
        expect(loadConfig({}).visitorSalt).not.toBe(loadConfig({}).visitorSalt);
        expect(() => loadConfig({ VISITOR_SALT: 'short' })).toThrow(/VISITOR_SALT/);
    });

    test('explicit origins win and lose their trailing slash', () => {
        const c = loadConfig({
            SHORT_ORIGIN: 'https://s.example/',
            DASH_ORIGIN: 'https://d.example'
        });
        expect(c.shortOrigin).toBe('https://s.example');
        expect(c.dashOrigin).toBe('https://d.example');
    });

    test('empty strings count as unset', () => {
        expect(loadConfig({ SHORT_PORT: '', DB_PATH: '' }).shortPort).toBe(3000);
    });

    test('rejects bad values', () => {
        expect(() => loadConfig({ SHORT_PORT: 'nope' })).toThrow(/SHORT_PORT/);
        expect(() => loadConfig({ DASH_ORIGIN: 'ftp://x' })).toThrow(/DASH_ORIGIN/);
        expect(() => loadConfig({ SHORT_PORT: '4000', DASH_PORT: '4000' })).toThrow(/must differ/);
        expect(() => loadConfig({ CF_ACCESS_AUD: 'abc' })).toThrow(/CF_ACCESS/);
    });

    test('Cloudflare Access config', () => {
        const c = loadConfig({
            CF_ACCESS_TEAM_DOMAIN: 'me.cloudflareaccess.com',
            CF_ACCESS_AUD: 'aud'
        });
        expect(c.cfAccess).toEqual({ teamDomain: 'me.cloudflareaccess.com', aud: 'aud' });
    });
});
