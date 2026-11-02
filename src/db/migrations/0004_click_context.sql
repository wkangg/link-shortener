-- More from the device-signals page (only on links with track_device = 1), shown
-- per click and not part of the fingerprint.

-- How the click happened.
ALTER TABLE clicks ADD COLUMN history_length INTEGER;  -- history.length; 1 = a fresh tab, usually opened from an app
ALTER TABLE clicks ADD COLUMN visibility TEXT;         -- visible | hidden (background tab) | prerender
ALTER TABLE clicks ADD COLUMN nav_type TEXT;           -- navigate | reload | back_forward | prerender
ALTER TABLE clicks ADD COLUMN has_opener INTEGER CHECK (has_opener IN (0, 1)); -- window.opener set
ALTER TABLE clicks ADD COLUMN page_referrer TEXT;      -- document.referrer as the page saw it

-- The real browser, and automation tells.
ALTER TABLE clicks ADD COLUMN browser_brand TEXT;      -- Brave | DuckDuckGo | Opera | Arc behind a Chrome-like user agent
ALTER TABLE clicks ADD COLUMN nav_platform TEXT;       -- navigator.platform, e.g. "Win32"
ALTER TABLE clicks ADD COLUMN nav_vendor TEXT;         -- navigator.vendor, e.g. "Google Inc."
ALTER TABLE clicks ADD COLUMN oscpu TEXT;              -- navigator.oscpu (Firefox)
ALTER TABLE clicks ADD COLUMN automation TEXT;         -- JSON array of automation leftovers and headless tells; [] = none
ALTER TABLE clicks ADD COLUMN timer_ms REAL;           -- performance.now() resolution; coarse in Tor / resist-fingerprinting

-- Hardware.
ALTER TABLE clicks ADD COLUMN cpu_ms REAL;             -- ms for a fixed workload (lower is faster)
ALTER TABLE clicks ADD COLUMN heap_limit INTEGER;      -- performance.memory.jsHeapSizeLimit, bytes (Chromium)
ALTER TABLE clicks ADD COLUMN refresh_hz INTEGER;      -- screen refresh rate
ALTER TABLE clicks ADD COLUMN biometrics INTEGER CHECK (biometrics IN (0, 1)); -- platform authenticator (Windows Hello, Touch ID...)
ALTER TABLE clicks ADD COLUMN bluetooth INTEGER CHECK (bluetooth IN (0, 1));   -- Bluetooth adapter available (Chromium)

-- Display and browser settings.
ALTER TABLE clicks ADD COLUMN font_size REAL;          -- default font size, px
ALTER TABLE clicks ADD COLUMN scrollbar INTEGER;       -- classic scrollbar width, px; 0 = overlay
ALTER TABLE clicks ADD COLUMN outer_size TEXT;         -- browser window outer size "WxH"
ALTER TABLE clicks ADD COLUMN blocked_storage TEXT;    -- JSON array of blocked storage APIs; [] = all work
