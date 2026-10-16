import pkg from '../package.json' with { type: 'json' };
import { startApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/client.ts';

const config = loadConfig();
const db = openDatabase(config.dbPath, { log: true });
const app = startApp({ config, db, version: pkg.version });

console.log(`[shortener] ${config.env} v${pkg.version}`);
console.log(`  short links → ${app.short.url}  (public: ${config.shortOrigin})`);
console.log(`  dashboard   → ${app.dash.url}  (public: ${config.dashOrigin})`);
console.log(`  database    → ${config.dbPath}`);
if (!config.cfAccess) console.log('  auth        → disabled (no Cloudflare Access config)');
console.log(
    config.abuseIpdb
        ? `  reputation  → AbuseIPDB, hiding scores ≥ ${config.abuseMinScore} by default`
        : '  reputation  → off (set ABUSEIPDB_API_KEY to hide reported IPs)'
);
if (config.isProd && !process.env.VISITOR_SALT) {
    console.warn('  warning     → VISITOR_SALT is unset; unique visitors reset on every restart');
}

let stopping = false;
async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`[shortener] ${signal} received, shutting down`);
    await app.stop(); // stops both servers, then writes any buffered clicks
    db.close();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
