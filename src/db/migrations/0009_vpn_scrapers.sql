-- Whether the device-signals page ran: NULL = no page was served (plain redirect
-- or a bot), 0 = served but nothing came back (yet), 1 = the browser reported in.
ALTER TABLE clicks ADD COLUMN js INTEGER CHECK (js IN (0, 1));
-- navigator.webdriver, as reported by the device-signals page.
ALTER TABLE clicks ADD COLUMN webdriver INTEGER CHECK (webdriver IN (0, 1));

-- Set by analytics/classify.ts. `vpn` names the VPN or relay the click came
-- through (e.g. "Tor"); `scraper` says why the click looks automated. NULL = no.
ALTER TABLE clicks ADD COLUMN vpn     TEXT;
ALTER TABLE clicks ADD COLUMN scraper TEXT;

UPDATE clicks SET js = 1 WHERE screen IS NOT NULL;
UPDATE clicks SET js = 0 WHERE js IS NULL AND token IS NOT NULL;

-- VPN / relay address lists (Tor exits, iCloud Private Relay), fetched daily and
-- kept here so a restart doesn't need the network. `ranges` is one merged
-- "start-end" range per line, in hex, prefixed with 4 or 6.
CREATE TABLE ip_lists (
    name       TEXT PRIMARY KEY,
    ranges     TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
) STRICT;
