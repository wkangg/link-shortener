// Writes webhook events for new clicks. Runs inside the click flush transaction,
// so an event row exists exactly when its click row does.
import type { Database } from 'bun:sqlite';

/**
 * Endpoints that skip any of these wait this long before sending, so the
 * verdicts that land after the insert (hostname, VPN, abuse score) are in.
 */
export const SETTLE_DELAY_MS = 10_000;

const SETTLED_CATEGORIES = `'datacenter', 'scraper', 'abusive'`;

export class WebhookOutbox {
    readonly #db: Database;
    readonly #insert;
    #active = false;

    constructor(db: Database) {
        this.#db = db;
        // One row per enabled endpoint that wants this click: bots are dropped
        // here for endpoints that skip them, and an endpoint that isn't for every
        // link gets only its chosen links and links with one of its tags.
        this.#insert = db.query<never, [number, number, number, number]>(
            `INSERT INTO webhook_events (endpoint_id, click_id, event_id, due_at, created_at)
             SELECT e.id, ?1, 'evt_' || lower(hex(randomblob(12))),
                    ?4 + CASE WHEN EXISTS (
                        SELECT 1 FROM json_each(e.skip) WHERE value IN (${SETTLED_CATEGORIES})
                    ) THEN ${SETTLE_DELAY_MS} ELSE 0 END,
                    ?4
             FROM webhook_endpoints e
             WHERE e.enabled = 1
               AND NOT (?3 = 1 AND EXISTS (SELECT 1 FROM json_each(e.skip) WHERE value = 'bot'))
               AND (e.all_links = 1
                    OR EXISTS (SELECT 1 FROM webhook_endpoint_links el
                               WHERE el.endpoint_id = e.id AND el.link_id = ?2)
                    OR EXISTS (SELECT 1 FROM link_tags t JOIN json_each(e.tags) j ON j.value = t.tag
                               WHERE t.link_id = ?2))`
        );
        this.refresh();
    }

    /** At least one endpoint is enabled. When false, enqueue does nothing. */
    get active(): boolean {
        return this.#active;
    }

    /** Re-reads whether any endpoint is enabled. Call after endpoints change. */
    refresh(): void {
        this.#active =
            this.#db
                .query<{ n: number }, []>(
                    'SELECT EXISTS (SELECT 1 FROM webhook_endpoints WHERE enabled = 1) AS n'
                )
                .get()?.n === 1;
    }

    enqueue(clickId: number, linkId: number, isBot: 0 | 1, now: number): void {
        if (this.#active) this.#insert.run(clickId, linkId, isBot, now);
    }
}
