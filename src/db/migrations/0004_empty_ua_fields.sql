-- Unrecognized user agents were stored with an empty browser/os name instead of NULL,
-- which showed up as a blank row rather than "(none)".
UPDATE clicks SET browser = NULL WHERE browser = '';
UPDATE clicks SET os = NULL WHERE os = '';
