-- More browser-side traits from the device-signals page, only on links with
-- track_device = 1. They feed the fingerprint and are shown per click, except
-- dark_mode, which auto dark mode flips by time of day.
ALTER TABLE clicks ADD COLUMN browser_version TEXT; -- client hints, e.g. "Google Chrome 130.0.6723.92" (Chromium only)
ALTER TABLE clicks ADD COLUMN display TEXT;         -- "availWidth x availHeight x colorDepth", e.g. "1920x1032x24"
ALTER TABLE clicks ADD COLUMN codecs TEXT;          -- one digit per media type in shared/probes.ts CODECS
ALTER TABLE clicks ADD COLUMN fonts TEXT;           -- one bit per font in shared/probes.ts FONTS
ALTER TABLE clicks ADD COLUMN settings TEXT;        -- one bit per setting in shared/probes.ts SETTINGS
ALTER TABLE clicks ADD COLUMN dark_mode INTEGER CHECK (dark_mode IN (0, 1)); -- prefers-color-scheme: dark
