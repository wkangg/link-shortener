-- How the device-signals page (track_device = 1) trades speed for data:
--   speed:    send the visitor on right away and probe while the destination loads;
--             a fast destination can cut slow probes short (clicks.partial = 1).
--   complete: finish probing and report first, then send the visitor on (0.5-1 s
--             slower, but every probe gets its time).
ALTER TABLE links ADD COLUMN track_mode TEXT NOT NULL DEFAULT 'speed'
  CHECK (track_mode IN ('speed', 'complete'));
