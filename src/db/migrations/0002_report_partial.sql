-- The device-signals page reports once: when every async probe has finished, after
-- 0.5 s, or when the visitor leaves first (the destination loaded, or the page was
-- hidden). 1 = some probes were still running, so a missing value may mean "cut
-- short" rather than "not supported". NULL on clicks reported before this column.
ALTER TABLE clicks ADD COLUMN partial INTEGER CHECK (partial IN (0, 1));
