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

-- Copied onto each click from ip_reputation. NULL = not checked (yet).
ALTER TABLE clicks ADD COLUMN abuse_score INTEGER;
ALTER TABLE clicks ADD COLUMN isp         TEXT;

-- Reputation results are written to every click from that IP at once.
CREATE INDEX clicks_ip ON clicks (ip) WHERE ip IS NOT NULL;
