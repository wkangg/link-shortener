-- Client hints, network, storage and clock from the device-signals page (only on
-- links with track_device = 1), shown per click with the request details below.
ALTER TABLE clicks ADD COLUMN hint_model TEXT;      -- client hints model (Android phones), also copied to device_model
ALTER TABLE clicks ADD COLUMN cpu_arch TEXT;        -- client hints architecture and bitness, e.g. "x86 64-bit"
ALTER TABLE clicks ADD COLUMN form_factors TEXT;    -- client hints form factors, e.g. "Desktop"
ALTER TABLE clicks ADD COLUMN quota INTEGER;        -- navigator.storage quota in bytes
ALTER TABLE clicks ADD COLUMN downlink REAL;        -- Network Information estimated Mbps
ALTER TABLE clicks ADD COLUMN rtt INTEGER;          -- Network Information estimated round trip, ms
ALTER TABLE clicks ADD COLUMN save_data INTEGER CHECK (save_data IN (0, 1)); -- Data Saver on
ALTER TABLE clicks ADD COLUMN clock_skew INTEGER;   -- device clock minus server clock when the report arrived, ms
ALTER TABLE clicks ADD COLUMN report_ms INTEGER;    -- ms from the click to the page's report arriving

-- Server-side, every click: request details kept as received, since the
-- browser's own language and timezone overwrite those columns.
ALTER TABLE clicks ADD COLUMN accept_language TEXT; -- whole Accept-Language header
ALTER TABLE clicks ADD COLUMN ip_timezone TEXT;     -- CF-Timezone
