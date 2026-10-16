-- Per-link opt-in: serve a short JS page that reports browser-side signals
-- (battery, screen, GPU, ...) before forwarding, instead of a bare 30x.
ALTER TABLE links ADD COLUMN track_device INTEGER NOT NULL DEFAULT 0 CHECK (track_device IN (0, 1));

-- Server-side, every click.
ALTER TABLE clicks ADD COLUMN language     TEXT;     -- first Accept-Language tag (navigator.language when tracked)
ALTER TABLE clicks ADD COLUMN timezone     TEXT;     -- CF-Timezone header (the browser's own zone when tracked)
ALTER TABLE clicks ADD COLUMN hostname     TEXT;     -- reverse DNS of ip, filled in shortly after the insert
ALTER TABLE clicks ADD COLUMN bot_name     TEXT;     -- crawler name when is_bot = 1
ALTER TABLE clicks ADD COLUMN device_model TEXT;     -- vendor and model from the user agent, e.g. "Apple iPhone"

-- Browser-side, only on links with track_device = 1. NULL when not reported.
ALTER TABLE clicks ADD COLUMN token        TEXT;     -- one-time id the page reports back with; cleared once used
ALTER TABLE clicks ADD COLUMN screen       TEXT;     -- "1920x1080@2" (CSS pixels @ devicePixelRatio)
ALTER TABLE clicks ADD COLUMN orientation  TEXT;     -- portrait-primary | landscape-primary | ...
ALTER TABLE clicks ADD COLUMN battery      INTEGER;  -- 0-100 (Chromium only)
ALTER TABLE clicks ADD COLUMN charging     INTEGER CHECK (charging IN (0, 1));
ALTER TABLE clicks ADD COLUMN connection   TEXT;     -- Network Information API, e.g. "wifi" or "4g" (Chromium only)
ALTER TABLE clicks ADD COLUMN gpu          TEXT;     -- WebGL unmasked renderer
ALTER TABLE clicks ADD COLUMN incognito    INTEGER CHECK (incognito IN (0, 1));   -- heuristic
ALTER TABLE clicks ADD COLUMN ad_blocker   INTEGER CHECK (ad_blocker IN (0, 1));  -- bait element hidden

CREATE INDEX clicks_token ON clicks (token) WHERE token IS NOT NULL;
