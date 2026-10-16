-- A device fingerprint hash, derived from the user agent plus any browser-side
-- signals (screen, GPU, platform, ...). Unlike visitor_hash it holds no IP and
-- doesn't rotate daily, so the same device can be recognised across days and
-- networks. Server-only clicks get a weaker hash from the headers alone.
ALTER TABLE clicks ADD COLUMN fingerprint TEXT;

-- 1 when the click's IP reverse-resolves to a hosting/datacenter provider.
-- These are overwhelmingly bots and scripts, so the dashboard hides them by
-- default, like crawlers. Filled in with the hostname, shortly after insert.
ALTER TABLE clicks ADD COLUMN is_datacenter INTEGER NOT NULL DEFAULT 0 CHECK (is_datacenter IN (0, 1));

CREATE INDEX clicks_fingerprint ON clicks (fingerprint) WHERE fingerprint IS NOT NULL;
