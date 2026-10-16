-- Per-request click history: the raw IP address and user agent as received.
-- `ts` already holds the timestamp. Rows from before this migration have NULLs.
ALTER TABLE clicks ADD COLUMN ip         TEXT;   -- CF-Connecting-IP
ALTER TABLE clicks ADD COLUMN user_agent TEXT;   -- User-Agent header, capped at 512 chars
