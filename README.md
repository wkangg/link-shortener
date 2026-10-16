# Link shortener

A fast, self-hosted link shortener with built-in analytics, for one person or a small team. Runs on [Bun](https://bun.com) with SQLite: one process, one database file, no external services.

- **Fast redirects.** A short link is a hash-map lookup and a `302`. The request does no other I/O: clicks are queued in memory and written in batches. A cached redirect takes a few microseconds of server time.
- **Analytics:** clicks and unique visitors over time, plus top links, sources, referrers, countries, regions, cities, browsers, operating systems, devices, device fingerprints, UTM tags, query parameters and QR scans. Click any row to filter the whole dashboard. Export to CSV.
- **IP insight:** every click's IP links out to ipinfo.io and AbuseIPDB. Traffic from hosting/datacenter providers is hidden by default, the same way crawlers are. With an [AbuseIPDB](https://www.abuseipdb.com/) key, IPs reported for abuse are hidden too, each click shows its IP's ISP and abuse score, and datacenter detection uses AbuseIPDB's usage type instead of only reverse DNS. Toggle any of them back on.
- **Device fingerprint:** a coarse hash of each visitor's browser (user agent plus any reported screen, GPU and platform) groups clicks from the same device across days and IP changes. It holds no IP and isn't a unique-person identifier.
- **QR codes** for every link (PNG or SVG, custom colors and error correction). Scans are tracked separately from clicks.
- **Two domains:** short links on one (e.g. `s.example`), the dashboard on another (`dash.example`). The short domain never sets cookies.
- **Privacy-friendly:** raw IP addresses are never stored, only a daily-rotating salted hash for counting unique visitors. Location comes from your CDN's headers.

## Quick start

```sh
bun install
bun run seed      # optional: sample links and ~6 weeks of clicks
bun run dev
```

| URL                           | What                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ |
| http://localhost:3001         | Dashboard. Auth is off locally when no Cloudflare Access settings are present. |
| http://localhost:3000/<slug>  | Short links. `/` is 404 until you create a root link (slug `/`).               |
| http://localhost:3001/healthz | Health check                                                                   |

## Scripts

| Command                        |                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `bun run dev`                  | Dev server with restart on change; the dashboard has HMR                          |
| `bun run start`                | Run without watching                                                              |
| `bun run check`                | Format check, lint, type check and tests (what CI runs)                           |
| `bun run format`               | Format everything with `bun fmt`                                                  |
| `bun run lint` / `lint:fix`    | `bun lint` with the rules in `bunfig.toml`                                        |
| `bun test`                     | Tests                                                                             |
| `bun run seed [--clicks 5000]` | Fill the database with sample data                                                |
| `bun run backup`               | Consistent copy of the database to `BACKUP_DIR`, keeping the newest `BACKUP_KEEP` |
| `bun run bench`                | Redirect latency and throughput                                                   |

`bun fmt` and `bun lint` currently need a canary build of Bun: `bun upgrade --canary`.

## Configuration

All settings are environment variables; see [.env.example](./.env.example). Production requires:

| Variable                                 |                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `SHORT_ORIGIN`, `DASH_ORIGIN`            | Public URLs of the short-link domain and the dashboard            |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Cloudflare Access application that protects the dashboard         |
| `VISITOR_SALT`                           | Any long random string, so unique-visitor counts survive restarts |

Optional: set `ABUSEIPDB_API_KEY` (a free key allows 1,000 checks a day) to hide clicks from IPs reported for abuse. `ABUSEIPDB_MIN_SCORE` (default 25) is the abuse confidence at which a click is hidden. Each IP is checked at most once a week, and clicks from the last 30 days are checked at startup and every 6 hours, busiest IPs first, within `ABUSEIPDB_DAILY_LIMIT` (default 1000).

## How it works

- **Redirects** (`src/redirect`): the slug is looked up in an in-memory LRU, then one SQLite prepared statement, and a `302` goes back. The click is pushed onto an array. `HEAD` requests (link previews, uptime checks) redirect but aren't counted. Expired links return `410`.
- **Analytics** (`src/analytics`): once a second the queued clicks are enriched and written in one transaction. Enrichment covers browser/OS/device, bots, referrer to source, UTM tags, other query params, and the visitor hash. Bots are stored but hidden by default.
- **Dashboard** (`src/dashboard`): a JSON API on `Bun.serve` routes plus a React SPA. Every API request must carry a valid Cloudflare Access JWT. Editing a link clears its cache entry immediately.
- **QR codes** encode `https://<short-domain>/<slug>?qr`. The `?qr` is stripped before redirecting and recorded, so scans show up as their own source.
- **Query params** on a short link are passed on to the destination. `/abc?utm_source=newsletter` arrives with that UTM tag, and the dashboard reports it.

## Deploying

The included `Dockerfile` builds a small image that runs as a non-root user.

1. Route your short domain to container port `3000` and your dashboard domain to port `3001`.
2. Mount a persistent volume at `/data`.
3. Set the production variables above.
4. Health check: `GET /healthz` on port `3001`. The image also has a Docker `HEALTHCHECK`.
5. Back up daily with `bun run backup`, from cron or your platform's scheduled jobs.

The app expects to sit behind Cloudflare:

- Dashboard auth uses **Cloudflare Access**. Create a self-hosted application for the dashboard domain, and allow only yourself.
- Analytics read `CF-Connecting-IP`, `CF-IPCountry` and the visitor location headers (Rules > Transform Rules > Managed Transforms > "Add visitor location headers").
- Restrict the origin to Cloudflare's IP ranges, or use a Cloudflare Tunnel, so those headers can't be spoofed.

### Shortening from elsewhere

- **Bookmarklet:** drag it from the dashboard's Settings page to your bookmarks bar.
- **Scripts and iOS Shortcuts:** create a Cloudflare Access service token, allow it in the Access policy, and `POST /api/links` with its headers. Settings has a ready-to-copy `curl` command.

## Database migrations

Add `src/db/migrations/NNNN_description.sql`, numbered after the last one. It's applied once on the next boot, in its own transaction. Never edit a migration after it has been deployed.
