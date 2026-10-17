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
    -- JSON array of link tags; empty = clicks on every link.
    tags            TEXT    NOT NULL DEFAULT '[]',
    -- JSON array of click categories not to send: bot, datacenter, scraper, abusive, vpn.
    skip            TEXT    NOT NULL DEFAULT '["bot","datacenter","scraper","abusive"]',
    include_ip      INTEGER NOT NULL DEFAULT 0 CHECK (include_ip IN (0, 1)),
    -- Why the endpoint was turned off automatically (e.g. too many failures).
    disabled_reason TEXT,
    -- Start of the current run of failed attempts (unix ms); NULL after a success.
    failing_since   INTEGER,
    created_at      INTEGER NOT NULL,                    -- unix ms
    updated_at      INTEGER NOT NULL                     -- unix ms
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
