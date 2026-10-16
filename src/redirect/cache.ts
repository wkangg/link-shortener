// HOT PATH. Bounded in-memory cache of slug -> link, plus a short-lived cache of
// slugs that don't exist (so scanners can't hammer SQLite).

export interface CachedLink {
    id: number;
    url: string;
    status: number;
    expiresAt: number | null;
    /** Serve the device-signals page instead of a bare redirect. */
    track: boolean;
}

const MISS_TTL_MS = 60_000;

export class LinkCache {
    readonly #hits = new Map<string, CachedLink>();
    readonly #misses = new Map<string, number>();
    readonly #maxHits: number;
    readonly #maxMisses: number;

    constructor(maxHits = 50_000, maxMisses = 10_000) {
        this.#maxHits = maxHits;
        this.#maxMisses = maxMisses;
    }

    /** The link, `null` if recently confirmed missing, or `undefined` if unknown. */
    get(slug: string, now: number): CachedLink | null | undefined {
        const hit = this.#hits.get(slug);
        if (hit) {
            // Re-insert to mark as most recently used (Map keeps insertion order).
            this.#hits.delete(slug);
            this.#hits.set(slug, hit);
            return hit;
        }
        const missUntil = this.#misses.get(slug);
        if (missUntil === undefined) return undefined;
        if (missUntil > now) return null;
        this.#misses.delete(slug);
        return undefined;
    }

    set(slug: string, link: CachedLink | null, now: number): void {
        if (link) {
            this.#misses.delete(slug);
            this.#hits.set(slug, link);
            if (this.#hits.size > this.#maxHits) evictOldest(this.#hits);
        } else {
            this.#misses.set(slug, now + MISS_TTL_MS);
            if (this.#misses.size > this.#maxMisses) evictOldest(this.#misses);
        }
    }

    /** Forget a slug. Called by the dashboard after any write that touches it. */
    invalidate(slug: string): void {
        this.#hits.delete(slug);
        this.#misses.delete(slug);
    }

    clear(): void {
        this.#hits.clear();
        this.#misses.clear();
    }

    get size(): number {
        return this.#hits.size;
    }
}

function evictOldest(map: Map<string, unknown>): void {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
}
