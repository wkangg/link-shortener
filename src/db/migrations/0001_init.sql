-- Links: one row per short link.
CREATE TABLE links (
  id            INTEGER PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,             -- case-sensitive, [A-Za-z0-9_-]{1,64}
  url           TEXT    NOT NULL,                    -- destination
  title         TEXT,
  redirect_type INTEGER NOT NULL DEFAULT 302 CHECK (redirect_type IN (301, 302, 307, 308)),
  expires_at    INTEGER,                             -- unix ms, NULL = never
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    INTEGER NOT NULL,                    -- unix ms
  updated_at    INTEGER NOT NULL                     -- unix ms
) STRICT;

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
  visitor_hash  TEXT,                                -- hash(ip + ua + daily salt); raw IP never stored
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_term      TEXT,
  utm_content   TEXT,
  query         TEXT                                 -- JSON object of other query params, e.g. {"ref":"ig"}
) STRICT;

CREATE INDEX clicks_ts      ON clicks (ts);
CREATE INDEX clicks_link_ts ON clicks (link_id, ts);
