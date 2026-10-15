// Redirect benchmark. Starts the real server in a child process (fresh temp
// database), creates a link, then measures:
//   1. server time per redirect in-process (handler only, no network)
//   2. end-to-end HTTP latency and throughput from this process
// Usage: bun run bench [--seconds 5] [--concurrency 64]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ClickBuffer } from '../src/analytics/clicks.ts';
import { openDatabase } from '../src/db/client.ts';
import { LinkCache } from '../src/redirect/cache.ts';
import { createRedirectHandler } from '../src/redirect/handler.ts';
import { createLinkLookup } from '../src/redirect/lookup.ts';

const arg = (name: string, fallback: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : Number(process.argv[i + 1]) || fallback;
};
const seconds = arg('seconds', 5);
const concurrency = arg('concurrency', 64);

function percentiles(samples: Float64Array | number[]) {
    const sorted = Float64Array.from(samples).toSorted();
    const at = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}
const us = (ms: number) => `${(ms * 1000).toFixed(1)} µs`;

// ---- 1. handler only ----
{
    const db = openDatabase(':memory:');
    db.run(
        "INSERT INTO links (slug, url, created_at, updated_at) VALUES ('bench', 'https://example.com/landing', 0, 0)"
    );
    const handle = createRedirectHandler({
        dashOrigin: 'https://dash.example',
        cache: new LinkCache(),
        lookup: createLinkLookup(db),
        clicks: new ClickBuffer(db, { shortHost: 's.example', salt: 'bench', intervalMs: 1000 })
    });
    const headers = { 'user-agent': 'bench', 'cf-connecting-ip': '1.2.3.4' };
    for (let i = 0; i < 20_000; i++) handle(new Request('http://s.example/bench', { headers }));
    const n = 200_000;
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const req = new Request('http://s.example/bench?utm_source=x', { headers });
        const t = Bun.nanoseconds();
        handle(req);
        samples[i] = (Bun.nanoseconds() - t) / 1e6;
    }
    const p = percentiles(samples);
    console.log(
        `handler (cache hit, incl. click record): p50 ${us(p.p50)}  p99 ${us(p.p99)}  max ${us(p.max)}`
    );
    db.close();
}

// ---- 2. over HTTP ----
const dir = mkdtempSync(path.join(tmpdir(), 'shortener-bench-'));
const server = Bun.spawn(['bun', 'src/index.ts'], {
    env: {
        ...process.env,
        NODE_ENV: 'development',
        DB_PATH: path.join(dir, 'bench.db'),
        SHORT_PORT: '39100',
        DASH_PORT: '39101',
        CF_ACCESS_TEAM_DOMAIN: '',
        CF_ACCESS_AUD: ''
    },
    stdout: 'ignore',
    stderr: 'inherit'
});
try {
    for (let i = 0; i < 50; i++) {
        const ok = await fetch('http://127.0.0.1:39101/healthz').then(
            r => r.ok,
            () => false
        );
        if (ok) break;
        await Bun.sleep(100);
    }
    await fetch('http://127.0.0.1:39101/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/landing', slug: 'bench' })
    });

    const latencies: number[] = [];
    let errors = 0;
    const deadline = performance.now() + seconds * 1000;
    const worker = async () => {
        while (performance.now() < deadline) {
            const t = performance.now();
            const res = await fetch('http://127.0.0.1:39100/bench', { redirect: 'manual' });
            await res.arrayBuffer();
            if (res.status === 302) latencies.push(performance.now() - t);
            else errors++;
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const p = percentiles(latencies);
    console.log(
        `http (${concurrency} concurrent, ${seconds}s): ${Math.round(latencies.length / seconds).toLocaleString()} req/s  ` +
            `p50 ${p.p50.toFixed(2)} ms  p90 ${p.p90.toFixed(2)} ms  p99 ${p.p99.toFixed(2)} ms  errors ${errors}`
    );
    console.log('(HTTP numbers include the load generator, which shares this machine.)');
} finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
}
