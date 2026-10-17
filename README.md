<div align="center">

# Link Shortener

**A fast, self-hosted link shortener with built-in analytics.**

One process, one SQLite file, no external services required.

[![CI](https://github.com/wkangg/link-shortener/actions/workflows/ci.yml/badge.svg)](https://github.com/wkangg/link-shortener/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![SQLite](https://img.shields.io/badge/database-SQLite-003b57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/deploy-Docker-2496ed?logo=docker&logoColor=white)](./Dockerfile)

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [Deployment](#deployment) · [Architecture](#architecture) · [Development](#development)

</div>

---

## Features

### ⚡ Fast redirects

A redirect is an in-memory lookup and a `302`, with no other I/O on the request path. Clicks are queued in memory and written to the database in batches. A cached redirect takes a few microseconds of server time.

### 📊 Analytics

- Clicks and unique visitors over time.
- Top links, sources, referrers, countries, regions, cities, browsers, operating systems, devices, UTM tags, query parameters and QR scans.
- Click any row to filter the whole dashboard. Export everything to CSV.
- Per-click history showing device, browser, location, IP, ISP and abuse score, with relative timestamps.

### 🔎 Searchable click history

A small query language over every recorded property, with autocomplete for fields, flags and values:

```text
firefox                   any text field contains "firefox"
"san francisco"           quoted phrase
isp:comcast ip:203.0.     field contains a value
ip:=203.0.113.5           exact match (case-insensitive)
ram:>=8 battery:<20       numeric comparisons
is:vpn is:mobile          flags: bot, datacenter, vpn, scraper, abusive, private, adblock, qr, …
has:gpu                   field is set
-os:windows -is:bot       a leading - negates any term
```

Terms are AND-ed. The search filters the totals, chart, top lists, history and CSV export together.

### 🛡️ Traffic quality

| Category                 | Default | How it's detected                                                                          |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| Bots and crawlers        | Hidden  | User agent                                                                                 |
| Datacenter / hosting IPs | Hidden  | Reverse DNS, plus AbuseIPDB usage type when it's configured                                |
| Scrapers                 | Hidden  | Automated behavior without a bot UA: `navigator.webdriver`, software GPU, missing headers… |
| Abusive IPs              | Hidden  | [AbuseIPDB](https://www.abuseipdb.com/) confidence score (optional)                        |
| VPN, Tor and relays      | Shown   | Public Tor and iCloud Private Relay lists, Cloudflare WARP ranges, VPN-like behavior       |

Each category has its own toggle, and a search like `is:bot` overrides the default.

### 📱 Detailed device tracking (opt-in, per link)

When a link has tracking turned on, visitors see a short page instead of a bare redirect. The page reads what only the browser knows and then forwards them. It waits at most about 0.5 s, and a `<meta refresh>` covers browsers with JavaScript off. It records:

- OS version, screen size, orientation, GPU, RAM, touch points, network type and battery
- Private browsing and ad-blocker detection
- A coarse **device fingerprint** that groups one device's clicks across days and IP changes

### 🔳 QR codes

Every link has a QR code, as PNG or SVG with custom colors and error correction. Scans are tracked as their own source.

### 🌐 Two domains

Short links are served on one domain (e.g. `s.example`) and the dashboard on another (`dash.example`). The short domain never sets cookies.

---

## Quick start

> **Requirements:** [Bun](https://bun.com) 1.4+ (canary for `bun fmt` and `bun lint`; see [Development](#development))

```sh
git clone https://github.com/wkangg/link-shortener.git
cd link-shortener
bun install
bun run dev
```

| URL                             | What                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| `http://localhost:3001`         | Dashboard. Auth is off locally when Cloudflare Access isn't configured. |
| `http://localhost:3000/<slug>`  | Short links. `/` returns 404 until you create a root link (slug `/`).   |
| `http://localhost:3001/healthz` | Health check                                                            |

---

## Configuration

All settings are environment variables. Copy [`.env.example`](./.env.example) to `.env` for local overrides; Bun loads it automatically. Empty values count as unset.

### Required in production

| Variable                | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `SHORT_ORIGIN`          | Public URL of the short-link domain, e.g. `https://s.example`              |
| `DASH_ORIGIN`           | Public URL of the dashboard, e.g. `https://dash.example`                   |
| `CF_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access team domain, e.g. `yourteam.cloudflareaccess.com`   |
| `CF_ACCESS_AUD`         | Application Audience (AUD) tag of the dashboard's Access application       |
| `VISITOR_SALT`          | Random string of 16+ characters, so unique-visitor counts survive restarts |

### Optional

| Variable                | Default           | Description                                                                        |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`              | `development`     | `development`, `production` or `test`                                              |
| `SHORT_PORT`            | `3000`            | Port for short links                                                               |
| `DASH_PORT`             | `3001`            | Port for the dashboard                                                             |
| `DB_PATH`               | `./data/links.db` | SQLite file (`/data/links.db` in the Docker image)                                 |
| `ABUSEIPDB_API_KEY`     | none              | Turns on IP reputation lookups ([free key](https://www.abuseipdb.com/account/api)) |
| `ABUSEIPDB_MIN_SCORE`   | `25`              | Abuse confidence (1–100) at which a click is hidden                                |
| `ABUSEIPDB_DAILY_LIMIT` | `1000`            | Maximum lookups per day (the free plan allows 1,000)                               |
| `BACKUP_DIR`            | `/data/backups`   | Where `bun run backup` writes                                                      |
| `BACKUP_KEEP`           | `14`              | Number of backups to keep                                                          |

With AbuseIPDB on, each IP is checked at most once a week. Clicks from the last 30 days are checked at startup and every 6 hours, busiest IPs first.

---

## Deployment

The included [`Dockerfile`](./Dockerfile) builds a slim image that runs as a non-root user and has a built-in `HEALTHCHECK`.

```sh
docker build -t link-shortener .
docker run -d \
  -p 3000:3000 -p 3001:3001 \
  -v link-data:/data \
  --env-file .env \
  link-shortener
```

1. Route your short domain to container port **3000** and your dashboard domain to port **3001**.
2. Mount a persistent volume at **`/data`**.
3. Set the [production variables](#required-in-production).
4. Back up daily with `bun run backup`, from cron or your platform's scheduled jobs.

### Cloudflare

The app is designed to sit behind Cloudflare:

- **Authentication:** create a self-hosted Cloudflare Access application for the dashboard domain and allow only yourself. Every API request must carry a valid Access JWT.
- **Location data:** analytics read `CF-Connecting-IP`, `CF-IPCountry` and the visitor location headers. Turn these on under _Rules → Transform Rules → Managed Transforms → Add visitor location headers_.
- **Origin protection:** allow only Cloudflare's IP ranges to reach the origin, or use a Cloudflare Tunnel, so those headers can't be spoofed.

### Creating links from elsewhere

- **Bookmarklet:** drag it from the dashboard's Settings page to your bookmarks bar.
- **Scripts and iOS Shortcuts:** create a Cloudflare Access service token, allow it in the Access policy, and `POST /api/links` with its headers. Settings has a ready-to-copy `curl` command.

---

## Architecture

```text
             ┌────────────────────── one Bun process ──────────────────────┐
 visitor ──▶ │ :3000 redirect ─▶ LRU cache ─▶ SQLite ─▶ 302 / tracking page │
             │        │                                                    │
             │        └─▶ in-memory click queue ─▶ enrich ─▶ batch write   │
             │                                                (1 s)       │
 you ──────▶ │ :3001 dashboard ─▶ Cloudflare Access JWT ─▶ JSON API + SPA  │
             └─────────────────────────────────────────────────────────────┘
```

| Module                             | Responsibility                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/redirect`](./src/redirect)   | Slug lookup (LRU cache, then one prepared statement), the device-tracking page and click capture. `HEAD` requests redirect without counting; expired links return `410`.                                |
| [`src/analytics`](./src/analytics) | Once a second, enriches queued clicks (UA parsing, bot, VPN and datacenter detection, referrer → source, UTM tags, visitor hash) and writes them in one transaction. Also stats, search and reputation. |
| [`src/dashboard`](./src/dashboard) | JSON API on `Bun.serve` routes, Cloudflare Access auth and a React SPA. Editing a link clears its cache entry immediately.                                                                              |
| [`src/db`](./src/db)               | SQLite client and numbered SQL migrations                                                                                                                                                               |

Two more behaviors worth knowing:

- **Query parameters pass through.** `/abc?utm_source=newsletter` arrives at the destination with the tag, and the dashboard reports it.
- **QR codes** encode `https://<short-domain>/<slug>?qr`. The `?qr` is removed before redirecting and recorded, so scans show up as their own source.

---

## Privacy

This is an analytics tool, and it records a lot about each click. Know what's stored before you deploy:

- **IP addresses are stored** with each click, along with ISP, reverse DNS hostname and abuse score, for the click history and reputation checks.
- **Unique visitors** are counted with a hash of your `VISITOR_SALT`, the IP and the user agent. The same IP and browser count as one visitor across any date range.
- **Location** comes from Cloudflare's headers. There's no GeoIP database.
- **Device signals and fingerprints** are collected only on links with detailed tracking turned on. A fingerprint is a coarse hash of browser properties, not an identifier for a person.
- Every click lives in one SQLite file you control. No data goes to third parties, except IP lookups to AbuseIPDB when you configure a key.

You're responsible for meeting the privacy laws that apply to you (GDPR and similar) when you collect this data.

---

## Development

| Command                        | Description                                                       |
| ------------------------------ | ----------------------------------------------------------------- |
| `bun run dev`                  | Dev server that restarts on changes; the dashboard has HMR        |
| `bun run start`                | Run without watching                                              |
| `bun run check`                | Format check, lint, type check and tests (what CI runs)           |
| `bun test`                     | Run the test suite                                                |
| `bun run typecheck`            | `tsc --noEmit`                                                    |
| `bun run format`               | Format everything with `bun fmt`                                  |
| `bun run lint` / `lint:fix`    | Lint with the rules in [`bunfig.toml`](./bunfig.toml)             |
| `bun run seed [--clicks 5000]` | Fill the database with sample data                                |
| `bun run backup`               | Consistent copy of the database, keeping the newest `BACKUP_KEEP` |
| `bun run bench`                | Measure redirect latency and throughput                           |

> [!NOTE]
> `bun fmt` and `bun lint` are only in canary builds of Bun so far. Run `bun upgrade --canary` to get them.

### Database migrations

Add `src/db/migrations/NNNN_description.sql`, numbered after the last one. It runs once, in its own transaction, on the next boot.

> [!WARNING]
> Never edit a migration after it has been deployed. Add a new one instead.

### Contributing

1. Fork the repository and create a branch.
2. Make your change, with tests.
3. Run `bun run check` until it passes.
4. Open a pull request.
