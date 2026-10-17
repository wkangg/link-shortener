-- Webhook endpoints can be for every link, or only for chosen links and tags.

-- 1 = clicks on every link; 0 = only the links in webhook_endpoint_links and
-- links with one of the endpoint's tags. Endpoints that already had tags keep
-- meaning "only those tags".
ALTER TABLE webhook_endpoints ADD COLUMN all_links INTEGER NOT NULL DEFAULT 1 CHECK (all_links IN (0, 1));
UPDATE webhook_endpoints SET all_links = 0 WHERE json_array_length(tags) > 0;

-- The links an endpoint was chosen for. Deleting either side removes the row.
CREATE TABLE webhook_endpoint_links (
    endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
    link_id     INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    PRIMARY KEY (endpoint_id, link_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX webhook_endpoint_links_link ON webhook_endpoint_links (link_id);
