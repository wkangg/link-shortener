-- More Cloudflare edge data, server-side on every click.

-- From the "Add visitor location headers" managed transform (enable it in
-- Rules -> Settings). CF-IPCity/Region/Country already arrive without it.
ALTER TABLE clicks ADD COLUMN continent   TEXT;  -- CF-IPContinent, e.g. "NA"
ALTER TABLE clicks ADD COLUMN region_code TEXT;  -- CF-Region-Code (ISO subdivision), e.g. "NY"
ALTER TABLE clicks ADD COLUMN postal_code TEXT;  -- CF-Postal-Code
ALTER TABLE clicks ADD COLUMN metro_code  TEXT;  -- CF-Metro-Code (US DMA)

-- The Cloudflare edge datacenter that served the click, parsed from CF-RAY
-- (always present), e.g. "EWR". A coarse routing/location hint.
ALTER TABLE clicks ADD COLUMN edge_colo   TEXT;

-- The IP's network. Not a default header: add a Transform Rule (Rules ->
-- Transform Rules -> Modify Request Header) that sets, on the redirect host,
--   cf-asn    = ip.src.asnum
--   cf-as-org = ip.src.as_org   (needs a Worker on some plans; harmless if absent)
-- ASN names the network directly (datacenter/VPN/ISP) without an AbuseIPDB call.
ALTER TABLE clicks ADD COLUMN asn         INTEGER;
ALTER TABLE clicks ADD COLUMN as_org      TEXT;
