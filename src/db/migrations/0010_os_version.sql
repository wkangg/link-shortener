-- OS version, e.g. "18.6" or "26.0". Only filled for iOS / iPadOS for now (see
-- analytics/apple.ts). Existing rows are backfilled by db/repair.ts.
ALTER TABLE clicks ADD COLUMN os_version TEXT;
