-- Links: one row per short link.
CREATE TABLE links (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,             -- [A-Za-z0-9_-]{1,64}; matched case-insensitively
  url           TEXT    NOT NULL,                    -- destination
  title         TEXT,
  redirect_type INTEGER NOT NULL DEFAULT 302 CHECK (redirect_type IN (301, 302, 307, 308)),
  expires_at    INTEGER,                             -- unix ms, NULL = never
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    INTEGER NOT NULL,                    -- unix ms
  updated_at    INTEGER NOT NULL,                    -- unix ms
  -- Serve a short JS page that reports browser-side signals (battery, screen,
  -- GPU, ...) before forwarding, instead of a bare 30x.
  track_device  INTEGER NOT NULL DEFAULT 0 CHECK (track_device IN (0, 1))
) STRICT;

-- Free-form tags on links (many-to-many). Deleting a link removes its tags.
CREATE TABLE link_tags (
    link_id INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL,
    PRIMARY KEY (link_id, tag)
) STRICT, WITHOUT ROWID;

-- Slugs match case-insensitively: /GitHub and /github are the same link. The
-- slug keeps the casing it was created with for display. Lookups compare with
-- COLLATE NOCASE, so they use this index.
CREATE UNIQUE INDEX links_slug_nocase ON links (slug COLLATE NOCASE);

CREATE INDEX link_tags_tag ON link_tags (tag);

-- Clicks: one row per redirect, written in batches by the click flusher.
-- No foreign key to links on purpose: a click buffered in memory for a link
-- deleted before the next flush must not abort the whole batch. Deleting a
-- link deletes its clicks explicitly.
CREATE TABLE clicks (
  id            INTEGER PRIMARY KEY,
  link_id       INTEGER NOT NULL,
  ts            INTEGER NOT NULL,                    -- unix ms
  country       TEXT,                                -- ISO 3166-1 alpha-2 from CF-IPCountry
  region        TEXT,
  city          TEXT,
  referrer_host TEXT,
  referrer      TEXT,
  source        TEXT    NOT NULL DEFAULT 'Direct',   -- normalized channel (QR, X, Gmail, Direct, ...)
  via_qr        INTEGER NOT NULL DEFAULT 0 CHECK (via_qr IN (0, 1)),
  device        TEXT,                                -- desktop | mobile | tablet
  browser       TEXT,
  os            TEXT,
  is_bot        INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  visitor_hash  TEXT,                                -- hash(salt + ip + ua), for unique visitors
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_term      TEXT,
  utm_content   TEXT,
  query         TEXT,                                -- JSON object of other query params, e.g. {"ref":"ig"}
  ip            TEXT,                                -- CF-Connecting-IP
  user_agent    TEXT,                                -- User-Agent header, capped at 512 chars

  -- Server-side, every click.
  language      TEXT,                                -- first Accept-Language tag (navigator.language when tracked)
  timezone      TEXT,                                -- CF-Timezone header (the browser's own zone when tracked)
  hostname      TEXT,                                -- reverse DNS of ip, filled in shortly after the insert
  bot_name      TEXT,                                -- crawler name when is_bot = 1
  device_model  TEXT,                                -- vendor and model from the user agent, e.g. "Apple iPhone"

  -- Browser-side, only on links with track_device = 1. NULL when not reported.
  token         TEXT,                                -- one-time id the page reports back with; cleared once used
  screen        TEXT,                                -- "1920x1080@2" (CSS pixels @ devicePixelRatio)
  orientation   TEXT,                                -- portrait-primary | landscape-primary | ...
  battery       INTEGER,                             -- 0-100 (Chromium only)
  charging      INTEGER CHECK (charging IN (0, 1)),
  connection    TEXT,                                -- Network Information API, e.g. "wifi" or "4g" (Chromium only)
  gpu           TEXT,                                -- WebGL unmasked renderer
  incognito     INTEGER CHECK (incognito IN (0, 1)),  -- heuristic
  ad_blocker    INTEGER CHECK (ad_blocker IN (0, 1)), -- bait element hidden

  -- Server-side, every click: approximate (city-level) coordinates of the IP.
  latitude      REAL,                                -- CF-IPLatitude
  longitude     REAL,                                -- CF-IPLongitude

  -- Browser-side, only on links with track_device = 1.
  memory        REAL,                                -- navigator.deviceMemory in GB, rounded by the browser (Chromium only)
  platform      TEXT,                                -- from client hints, e.g. "Windows 11" or "macOS 14.5" (Chromium only)
  touch_points  INTEGER,                             -- navigator.maxTouchPoints; 0 = no touch

  -- Device fingerprint hash from the user agent plus any browser-side signals
  -- (analytics/fingerprint.ts). Holds no IP, so it groups one device's clicks
  -- across networks. Server-only clicks get a weaker hash from the headers alone.
  fingerprint   TEXT,
  -- 1 when the IP belongs to a hosting/datacenter provider (reverse DNS, or
  -- AbuseIPDB usage type). Hidden by default, like crawlers.
  is_datacenter INTEGER NOT NULL DEFAULT 0 CHECK (is_datacenter IN (0, 1)),

  -- Copied onto each click from ip_reputation. NULL = not checked (yet).
  abuse_score   INTEGER,
  isp           TEXT,

  -- Whether the device-signals page ran: NULL = no page was served (plain redirect
  -- or a bot), 0 = served but nothing came back (yet), 1 = the browser reported in.
  js            INTEGER CHECK (js IN (0, 1)),
  webdriver     INTEGER CHECK (webdriver IN (0, 1)), -- navigator.webdriver, from the device-signals page

  -- Set by analytics/classify.ts. `vpn` names the VPN or relay the click came
  -- through (e.g. "Tor"); `scraper` says why the click looks automated. NULL = no.
  vpn           TEXT,
  scraper       TEXT,

  -- OS version, e.g. "18.6" or "26.0". Only filled for iOS / iPadOS for now
  -- (see analytics/apple.ts).
  os_version    TEXT,

  -- Browser-side, only on links with track_device = 1: navigator.hardwareConcurrency,
  -- the logical CPU cores the browser exposes.
  cpu_cores     INTEGER,

  -- More browser-side traits from the device-signals page, only on links with
  -- track_device = 1. All are shown per click. Those up to languages feed the
  -- fingerprint, except dark_mode (auto dark mode flips it by time of day).
  browser_version TEXT,                              -- client hints, e.g. "Google Chrome 130.0.6723.92" (Chromium only)
  display         TEXT,                              -- "availWidth x availHeight x colorDepth", e.g. "1920x1032x24"
  codecs          TEXT,                              -- one digit per media type in shared/probes.ts CODECS
  fonts           TEXT,                              -- one bit per font in shared/probes.ts FONTS
  settings        TEXT,                              -- one bit per setting in shared/probes.ts SETTINGS
  dark_mode       INTEGER CHECK (dark_mode IN (0, 1)), -- prefers-color-scheme: dark
  webgl           TEXT,                              -- JSON: limits, versions, extensions
  keyboard        TEXT,                              -- layout characters in US QWERTY key order (Chromium only)
  intl            TEXT,                              -- JSON: locale, calendar, numbering, hour cycle, sample date and number
  languages       TEXT,                              -- JSON array: navigator.languages

  -- Shown per click only.
  canvas          TEXT,                              -- hash of a drawn canvas, or "randomized"
  audio           TEXT,                              -- sum of an offline-rendered audio signal
  media_features  TEXT,                              -- JSON: color gamut, HDR, pointer, hover
  voices          TEXT,                              -- JSON array: speech synthesis voices
  emoji           INTEGER,                           -- newest emoji version drawn in color
  math            TEXT,                              -- hash of Math function results
  media_devices   TEXT,                              -- JSON: camera, microphone, speaker counts
  permissions     TEXT,                              -- JSON: permission states
  multi_monitor   INTEGER CHECK (multi_monitor IN (0, 1)), -- screen.isExtended
  webgpu          TEXT,                              -- JSON: adapter vendor, architecture, device, description
  viewport        TEXT,                              -- window inner size "WxH"

  -- Client hints, network, storage and clock from the device-signals page (only on
  -- links with track_device = 1), shown per click with the request details below.
  hint_model      TEXT,                              -- client hints model (Android phones), also copied to device_model
  cpu_arch        TEXT,                              -- client hints architecture and bitness, e.g. "x86 64-bit"
  form_factors    TEXT,                              -- client hints form factors, e.g. "Desktop"
  quota           INTEGER,                           -- navigator.storage quota in bytes
  downlink        REAL,                              -- Network Information estimated Mbps
  rtt             INTEGER,                           -- Network Information estimated round trip, ms
  save_data       INTEGER CHECK (save_data IN (0, 1)), -- Data Saver on
  clock_skew      INTEGER,                           -- device clock minus server clock when the report arrived, ms
  report_ms       INTEGER,                           -- ms from the click to the page's report arriving

  -- Server-side, every click: request details kept as received, since the
  -- browser's own language and timezone overwrite those columns.
  accept_language TEXT,                              -- whole Accept-Language header
  ip_timezone     TEXT,                              -- CF-Timezone

  -- More from the device-signals page (only on links with track_device = 1), shown
  -- per click and not part of the fingerprint.

  -- How the click happened.
  history_length  INTEGER,                           -- history.length; 1 = a fresh tab, usually opened from an app
  visibility      TEXT,                              -- visible | hidden (background tab) | prerender
  nav_type        TEXT,                              -- navigate | reload | back_forward | prerender
  has_opener      INTEGER CHECK (has_opener IN (0, 1)), -- window.opener set
  page_referrer   TEXT,                              -- document.referrer as the page saw it

  -- The real browser, and automation tells.
  browser_brand   TEXT,                              -- Brave | DuckDuckGo | Opera | Arc behind a Chrome-like user agent
  nav_platform    TEXT,                              -- navigator.platform, e.g. "Win32"
  nav_vendor      TEXT,                              -- navigator.vendor, e.g. "Google Inc."
  oscpu           TEXT,                              -- navigator.oscpu (Firefox)
  automation      TEXT,                              -- JSON array of automation leftovers and headless tells; [] = none
  timer_ms        REAL,                              -- performance.now() resolution; coarse in Tor / resist-fingerprinting

  -- Hardware.
  cpu_ms          REAL,                              -- ms for a fixed workload (lower is faster)
  heap_limit      INTEGER,                           -- performance.memory.jsHeapSizeLimit, bytes (Chromium)
  refresh_hz      INTEGER,                           -- screen refresh rate
  biometrics      INTEGER CHECK (biometrics IN (0, 1)), -- platform authenticator (Windows Hello, Touch ID...)
  bluetooth       INTEGER CHECK (bluetooth IN (0, 1)),  -- Bluetooth adapter available (Chromium)

  -- Display and browser settings.
  font_size       REAL,                              -- default font size, px
  scrollbar       INTEGER,                           -- classic scrollbar width, px; 0 = overlay
  outer_size      TEXT,                              -- browser window outer size "WxH"
  blocked_storage TEXT,                              -- JSON array of blocked storage APIs; [] = all work

  -- More Cloudflare edge data, server-side on every click.

  -- From the "Add visitor location headers" managed transform (enable it in
  -- Rules -> Settings). CF-IPCity/Region/Country already arrive without it.
  continent       TEXT,                              -- CF-IPContinent, e.g. "NA"
  region_code     TEXT,                              -- CF-Region-Code (ISO subdivision), e.g. "NY"
  postal_code     TEXT,                              -- CF-Postal-Code
  metro_code      TEXT,                              -- CF-Metro-Code (US DMA)

  -- The Cloudflare edge datacenter that served the click, parsed from CF-RAY
  -- (always present), e.g. "EWR". A coarse routing/location hint.
  edge_colo       TEXT,

  -- The IP's network. Not a default header (and Cloudflare won't let rules set
  -- cf-* names), so a Worker on the redirect host sets x-asn from request.cf.asn
  -- and x-as-org from request.cf.asOrganization. A Transform Rule setting
  -- x-asn = ip.src.asnum also works for the number alone; the name needs the Worker.
  asn             INTEGER,
  as_org          TEXT
) STRICT;

CREATE INDEX clicks_ts      ON clicks (ts);
CREATE INDEX clicks_link_ts ON clicks (link_id, ts);
CREATE INDEX clicks_token ON clicks (token) WHERE token IS NOT NULL;
CREATE INDEX clicks_fingerprint ON clicks (fingerprint) WHERE fingerprint IS NOT NULL;
-- Reputation results are written to every click from that IP at once.
CREATE INDEX clicks_ip ON clicks (ip) WHERE ip IS NOT NULL;

-- AbuseIPDB reputation per IP address. Optional: only filled when ABUSEIPDB_API_KEY
-- is set. Kept here so restarts don't spend the daily lookup quota again.
CREATE TABLE ip_reputation (
    ip          TEXT PRIMARY KEY,
    abuse_score INTEGER NOT NULL,  -- abuse confidence, 0-100
    reports     INTEGER NOT NULL,  -- reports in the last 90 days
    usage_type  TEXT,              -- e.g. "Data Center/Web Hosting/Transit", "Fixed Line ISP"
    isp         TEXT,
    checked_at  INTEGER NOT NULL
) STRICT;

-- VPN / relay address lists (Tor exits, iCloud Private Relay), fetched daily and
-- kept here so a restart doesn't need the network. `ranges` is one merged
-- "start-end" range per line, in hex, prefixed with 4 or 6.
CREATE TABLE ip_lists (
    name       TEXT PRIMARY KEY,
    ranges     TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
) STRICT;

-- Webhooks: endpoints managed in the dashboard, and an outbox of events to send.
-- One row per endpoint. `standard` endpoints get signed JSON (Standard Webhooks);
-- `discord` endpoints get embeds, and the token in the URL is the credential.
CREATE TABLE webhook_endpoints (
    id              INTEGER PRIMARY KEY,
    kind            TEXT    NOT NULL CHECK (kind IN ('standard', 'discord')),
    url             TEXT    NOT NULL,
    description     TEXT,
    secret          TEXT,                                -- whsec_<base64>; NULL for discord
    enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    -- JSON array of link tags.
    tags            TEXT    NOT NULL DEFAULT '[]',
    -- JSON array of click categories not to send: bot, datacenter, scraper, abusive, vpn.
    skip            TEXT    NOT NULL DEFAULT '["bot","datacenter","scraper","abusive"]',
    include_ip      INTEGER NOT NULL DEFAULT 0 CHECK (include_ip IN (0, 1)),
    -- Why the endpoint was turned off automatically (e.g. too many failures).
    disabled_reason TEXT,
    -- Start of the current run of failed attempts (unix ms); NULL after a success.
    failing_since   INTEGER,
    created_at      INTEGER NOT NULL,                    -- unix ms
    updated_at      INTEGER NOT NULL,                    -- unix ms
    -- 1 = clicks on every link; 0 = only the links in webhook_endpoint_links and
    -- links with one of the endpoint's tags.
    all_links       INTEGER NOT NULL DEFAULT 1 CHECK (all_links IN (0, 1))
) STRICT;

-- The outbox: one row per event per endpoint, written in the same transaction
-- as the click, so an event exists exactly when its click does.
CREATE TABLE webhook_events (
    id          INTEGER PRIMARY KEY,
    endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
    type        TEXT    NOT NULL DEFAULT 'link.clicked', -- link.clicked | webhook.test
    click_id    INTEGER,                                 -- NULL for test events
    event_id    TEXT    NOT NULL,                        -- webhook-id header; stable across retries
    status      TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'delivered', 'skipped', 'failed')),
    due_at      INTEGER NOT NULL,                        -- unix ms; next attempt for pending events
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_status INTEGER,                                 -- HTTP status of the last attempt
    last_error  TEXT,                                    -- why it failed or was skipped
    created_at  INTEGER NOT NULL,                        -- unix ms
    finished_at INTEGER                                  -- unix ms; when it left `pending`
) STRICT;

CREATE INDEX webhook_events_due ON webhook_events (due_at) WHERE status = 'pending';
CREATE INDEX webhook_events_endpoint ON webhook_events (endpoint_id, id);
CREATE INDEX webhook_events_finished ON webhook_events (finished_at) WHERE finished_at IS NOT NULL;

-- The links an endpoint was chosen for. Deleting either side removes the row.
CREATE TABLE webhook_endpoint_links (
    endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
    link_id     INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    PRIMARY KEY (endpoint_id, link_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX webhook_endpoint_links_link ON webhook_endpoint_links (link_id);
