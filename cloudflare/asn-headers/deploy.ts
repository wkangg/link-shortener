// Deploys the Worker on the short-link domain only, never the dashboard.
// The route comes from ROUTE (e.g. "s.example.com/*") or the app's SHORT_ORIGIN.

const origin = process.env.SHORT_ORIGIN;
const route = process.env.ROUTE ?? (origin ? `${new URL(origin).host}/*` : null);
if (!route) {
    throw new Error(
        `Set SHORT_ORIGIN (as in the app's .env) or ROUTE, e.g. ROUTE="s.example.com/*" bun run deploy`
    );
}

console.log(`Deploying to ${route}`);
const proc = Bun.spawn(
    [
        process.execPath,
        '--bun',
        './node_modules/wrangler/bin/wrangler.js',
        'deploy',
        'src/index.ts',
        '--name',
        'link-shortener-asn-headers',
        '--compatibility-date',
        '2026-10-01',
        '--route',
        route,
        ...process.argv.slice(2)
    ],
    { stdio: ['inherit', 'inherit', 'inherit'] }
);
process.exitCode = await proc.exited;
