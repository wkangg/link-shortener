-- Free-form tags on links (many-to-many). Deleting a link removes its tags.
CREATE TABLE link_tags (
    link_id INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL,
    PRIMARY KEY (link_id, tag)
) STRICT, WITHOUT ROWID;

CREATE INDEX link_tags_tag ON link_tags (tag);
