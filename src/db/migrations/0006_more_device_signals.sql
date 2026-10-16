-- Server-side, every click: approximate (city-level) coordinates of the IP.
ALTER TABLE clicks ADD COLUMN latitude     REAL;     -- CF-IPLatitude
ALTER TABLE clicks ADD COLUMN longitude    REAL;     -- CF-IPLongitude

-- Browser-side, only on links with track_device = 1.
ALTER TABLE clicks ADD COLUMN memory       REAL;     -- navigator.deviceMemory in GB, rounded by the browser (Chromium only)
ALTER TABLE clicks ADD COLUMN platform     TEXT;     -- from client hints, e.g. "Windows 11" or "macOS 14.5" (Chromium only)
ALTER TABLE clicks ADD COLUMN touch_points INTEGER;  -- navigator.maxTouchPoints; 0 = no touch
