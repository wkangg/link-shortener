-- Browser-side, only on links with track_device = 1: navigator.hardwareConcurrency,
-- the logical CPU cores the browser exposes. NULL when not reported.
ALTER TABLE clicks ADD COLUMN cpu_cores INTEGER;
