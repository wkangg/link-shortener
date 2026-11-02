-- More browser-side traits from the device-signals page, only on links with
-- track_device = 1. All are shown per click. Those up to languages feed the
-- fingerprint, except dark_mode (auto dark mode flips it by time of day).
ALTER TABLE clicks ADD COLUMN browser_version TEXT; -- client hints, e.g. "Google Chrome 130.0.6723.92" (Chromium only)
ALTER TABLE clicks ADD COLUMN display TEXT;         -- "availWidth x availHeight x colorDepth", e.g. "1920x1032x24"
ALTER TABLE clicks ADD COLUMN codecs TEXT;          -- one digit per media type in shared/probes.ts CODECS
ALTER TABLE clicks ADD COLUMN fonts TEXT;           -- one bit per font in shared/probes.ts FONTS
ALTER TABLE clicks ADD COLUMN settings TEXT;        -- one bit per setting in shared/probes.ts SETTINGS
ALTER TABLE clicks ADD COLUMN dark_mode INTEGER CHECK (dark_mode IN (0, 1)); -- prefers-color-scheme: dark
ALTER TABLE clicks ADD COLUMN webgl TEXT;           -- JSON: limits, versions, extensions
ALTER TABLE clicks ADD COLUMN keyboard TEXT;        -- layout characters in US QWERTY key order (Chromium only)
ALTER TABLE clicks ADD COLUMN intl TEXT;            -- JSON: locale, calendar, numbering, hour cycle, sample date and number
ALTER TABLE clicks ADD COLUMN languages TEXT;       -- JSON array: navigator.languages

-- Shown per click only.
ALTER TABLE clicks ADD COLUMN canvas TEXT;          -- hash of a drawn canvas, or "randomized"
ALTER TABLE clicks ADD COLUMN audio TEXT;           -- sum of an offline-rendered audio signal
ALTER TABLE clicks ADD COLUMN media_features TEXT;  -- JSON: color gamut, HDR, pointer, hover
ALTER TABLE clicks ADD COLUMN voices TEXT;          -- JSON array: speech synthesis voices
ALTER TABLE clicks ADD COLUMN emoji INTEGER;        -- newest emoji version drawn in color
ALTER TABLE clicks ADD COLUMN math TEXT;            -- hash of Math function results
ALTER TABLE clicks ADD COLUMN media_devices TEXT;   -- JSON: camera, microphone, speaker counts
ALTER TABLE clicks ADD COLUMN permissions TEXT;     -- JSON: permission states
ALTER TABLE clicks ADD COLUMN multi_monitor INTEGER CHECK (multi_monitor IN (0, 1)); -- screen.isExtended
ALTER TABLE clicks ADD COLUMN webgpu TEXT;          -- JSON: adapter vendor, architecture, device, description
ALTER TABLE clicks ADD COLUMN viewport TEXT;        -- window inner size "WxH"
