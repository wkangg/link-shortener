-- Slugs match case-insensitively: /GitHub and /github are the same link. The
-- slug keeps the casing it was created with for display.

-- Links that only differed by case can't all keep their slug. The oldest one
-- keeps it; each newer one gets its id appended (e.g. "GH" -> "GH-12").
UPDATE links
SET slug = substr(slug, 1, 64 - length('-' || id)) || '-' || id
WHERE EXISTS (
    SELECT 1 FROM links older
    WHERE lower(older.slug) = lower(links.slug) AND older.id < links.id
);

-- Lookups compare with COLLATE NOCASE, so they use this index.
CREATE UNIQUE INDEX links_slug_nocase ON links (slug COLLATE NOCASE);
