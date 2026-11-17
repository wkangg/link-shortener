import { describe, expect, test } from 'bun:test';

import { LinkRepo, SlugTakenError } from '../src/dashboard/links.ts';
import { linkSchemas } from '../src/dashboard/schemas.ts';
import { openDatabase } from '../src/db/client.ts';

function setup() {
    const db = openDatabase(':memory:');
    const invalidated: string[] = [];
    const repo = new LinkRepo(db, { invalidate: slug => invalidated.push(slug) }, () => 1000);
    return { db, repo, invalidated };
}

describe('LinkRepo', () => {
    test('create with a random slug', () => {
        const { repo } = setup();
        const link = repo.create({ url: 'https://example.com' });
        expect(link.slug).toMatch(/^[\da-z]{6}$/);
        expect(link).toMatchObject({ redirectType: 302, title: null, tags: [], archived: false });
    });

    test('custom slugs must be unique, ignoring case; the slug keeps its casing', () => {
        const { repo } = setup();
        const link = repo.create({ url: 'https://a.com', slug: 'GitHub' });
        expect(link.slug).toBe('GitHub');
        expect(() => repo.create({ url: 'https://b.com', slug: 'GitHub' })).toThrow(SlugTakenError);
        expect(() => repo.create({ url: 'https://b.com', slug: 'github' })).toThrow(SlugTakenError);
        const other = repo.create({ url: 'https://b.com', slug: 'other' });
        expect(() => repo.update(other.id, { slug: 'GITHUB' })).toThrow(SlugTakenError);
        expect(repo.getBySlug('GITHUB')?.id).toBe(link.id);
        // Re-casing a link's own slug is fine.
        expect(repo.update(link.id, { slug: 'github' })?.slug).toBe('github');
    });

    test('update changes fields, tags and invalidates old and new slugs', () => {
        const { repo, invalidated } = setup();
        const link = repo.create({ url: 'https://a.com', slug: 'old', tags: ['x'] });
        const updated = repo.update(link.id, {
            slug: 'new',
            url: 'https://b.com',
            tags: ['y', 'z'],
            redirectType: 301
        });
        expect(updated).toMatchObject({
            slug: 'new',
            url: 'https://b.com',
            tags: ['y', 'z'],
            redirectType: 301
        });
        expect(invalidated).toEqual(expect.arrayContaining(['old', 'new']));
        expect(repo.update(999, { title: 'x' })).toBeNull();
    });

    test('delete removes the link, its tags and its clicks', () => {
        const { db, repo } = setup();
        const link = repo.create({ url: 'https://a.com', tags: ['t'] });
        db.query('INSERT INTO clicks (link_id, ts) VALUES (?, 1)').run(link.id);
        expect(repo.delete(link.id)).toBe(true);
        expect(repo.get(link.id)).toBeNull();
        expect(db.query('SELECT COUNT(*) AS n FROM clicks').get()).toEqual({ n: 0 });
        expect(repo.allTags()).toEqual([]);
        expect(repo.delete(link.id)).toBe(false);
    });

    test('list: search, tags, archived, sort by clicks, sparkline', () => {
        const { db, repo } = setup();
        const a = repo.create({ url: 'https://alpha.com', slug: 'a', tags: ['work'] });
        const b = repo.create({ url: 'https://beta.com', slug: 'b', title: 'Beta 100%' });
        const c = repo.create({ url: 'https://gamma.com', slug: 'c' });
        repo.update(c.id, { archived: true });
        const insert = db.query('INSERT INTO clicks (link_id, ts, visitor_hash) VALUES (?, ?, ?)');
        insert.run(b.id, 500, 'v1');
        insert.run(b.id, 900, 'v1');

        expect(repo.list().links.map(l => l.slug)).toEqual(['b', 'a']);
        expect(repo.list({ archived: true }).links.map(l => l.slug)).toEqual(['c']);
        expect(repo.list({ q: 'alpha' }).links.map(l => l.slug)).toEqual(['a']);
        expect(repo.list({ q: '100%' }).links.map(l => l.slug)).toEqual(['b']);
        expect(repo.list({ tag: 'work' }).links.map(l => l.slug)).toEqual(['a']);

        const bySort = repo.list({ sort: 'clicks' });
        expect(bySort.links[0]).toMatchObject({ slug: 'b', clicks: 2, visitors: 1 });
        expect(bySort.links[0]?.spark.at(-1)).toBe(2);
        expect(bySort.total).toBe(2);
        expect(repo.allTags()).toEqual([{ tag: 'work', count: 1 }]);
        expect(a.tags).toEqual(['work']);
    });

    test('list counts only the clicks analytics shows by default', () => {
        const { db, repo } = setup();
        const link = repo.create({ url: 'https://a.com' });
        const insert = db.query(
            `INSERT INTO clicks (link_id, ts, visitor_hash, is_bot, scraper, is_datacenter, vpn, abuse_score)
             VALUES (?, 900, ?, ?, ?, ?, ?, ?)`
        );
        insert.run(link.id, 'person', 0, null, 0, null, null);
        insert.run(link.id, 'bot', 1, null, 0, null, null);
        insert.run(link.id, 'scraper', 0, 'No user agent', 0, null, null);
        insert.run(link.id, 'datacenter', 0, null, 1, null, null);
        insert.run(link.id, 'abusive', 0, null, 0, null, 80);

        const only = () => repo.list().links[0];
        expect(only()).toMatchObject({ clicks: 1, visitors: 1 });
        expect(only()?.spark.reduce((a, b) => a + b)).toBe(1);

        // A VPN on a hosting network is still a person.
        insert.run(link.id, 'vpn', 0, null, 1, 'Tor', null);
        expect(only()).toMatchObject({ clicks: 2, visitors: 2 });
        expect(only()?.spark.reduce((a, b) => a + b)).toBe(2);
    });
});

describe('link validation', () => {
    const { create, update } = linkSchemas('s.example');

    test('accepts a full link', () => {
        const parsed = create.parse({
            url: 'https://example.com/x',
            slug: 'my-link',
            title: 'Hi',
            redirectType: 301,
            expiresAt: 1,
            tags: ['Work', 'work', 'side']
        });
        expect(parsed.tags).toEqual(['work', 'side']);
    });

    test('rejects bad input', () => {
        expect(create.safeParse({ url: 'ftp://x.com' }).success).toBe(false);
        expect(create.safeParse({ url: 'https://s.example/loop' }).success).toBe(false);
        expect(create.safeParse({ url: 'https://x.com', slug: 'a b' }).success).toBe(false);
        expect(create.safeParse({ url: 'https://x.com', redirectType: 200 }).success).toBe(false);
        expect(create.safeParse({ url: 'https://x.com', extra: 1 }).success).toBe(false);
        expect(update.safeParse({ tags: ['bad tag'] }).success).toBe(false);
    });
});
