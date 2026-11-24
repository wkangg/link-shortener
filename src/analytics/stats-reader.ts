import type { Database } from 'bun:sqlite';

import type { StatsQuery } from '../shared/types.ts';
import type { StatsInit, StatsMethod, StatsReply, StatsRequest } from './stats-worker.ts';
import { BadQueryError, Stats } from './stats.ts';

type Run<M extends StatsMethod> = (...args: Parameters<Stats[M]>) => Promise<ReturnType<Stats[M]>>;

/**
 * The dashboard's stats, queried in a Worker (see stats-worker.ts) so a slow query
 * over many clicks doesn't hold up redirects. An in-memory database (tests) can't be
 * opened from another thread, so it's queried here. The CSV export stays here too:
 * it reads a page at a time and lets redirects run between pages.
 */
export class StatsReader {
    readonly #stats: Stats;
    readonly #init: StatsInit | null;
    readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
    /** Workers asked to stop, and what to call once they have. */
    readonly #stopped = new WeakMap<Worker, () => void>();
    #worker: Worker | null = null;
    #closed = false;
    #next = 0;

    constructor(db: Database, opts: { abuseMinScore: number }) {
        this.#stats = new Stats(db, opts);
        const file = db.filename;
        this.#init =
            file === ':memory:' || file === '' ? null : { file, abuseMinScore: opts.abuseMinScore };
    }

    summary: Run<'summary'> = (...args) => this.#run('summary', args);
    timeseries: Run<'timeseries'> = (...args) => this.#run('timeseries', args);
    top: Run<'top'> = (...args) => this.#run('top', args);
    suggest: Run<'suggest'> = (...args) => this.#run('suggest', args);
    history: Run<'history'> = (...args) => this.#run('history', args);

    csvPages(query: StatsQuery): Generator<string> {
        return this.#stats.csvPages(query);
    }

    /**
     * Answers the queries already asked, then closes the worker's connection (so the
     * database file isn't held open) and ends the worker.
     */
    async stop(): Promise<void> {
        this.#closed = true;
        const worker = this.#worker;
        this.#worker = null;
        if (!worker) return;
        const stopped = Promise.withResolvers<void>();
        this.#stopped.set(worker, stopped.resolve);
        worker.postMessage('stop');
        await stopped.promise;
        worker.terminate();
        this.#fail(new Error('Stats are shut down'));
    }

    #run<M extends StatsMethod>(
        method: M,
        args: Parameters<Stats[M]>
    ): Promise<ReturnType<Stats[M]>> {
        if (this.#closed) return Promise.reject(new Error('Stats are shut down'));
        if (!this.#init) {
            try {
                const run = this.#stats[method] as (...a: unknown[]) => ReturnType<Stats[M]>;
                return Promise.resolve(run.apply(this.#stats, args));
            } catch (error) {
                return Promise.reject(error);
            }
        }
        const id = this.#next++;
        const reply = Promise.withResolvers<unknown>();
        this.#pending.set(id, reply);
        const request: StatsRequest = { id, method, args };
        this.#spawn(this.#init).postMessage(request);
        return reply.promise as Promise<ReturnType<Stats[M]>>;
    }

    #spawn(init: StatsInit): Worker {
        if (this.#worker) return this.#worker;
        const worker = new Worker(new URL('stats-worker.ts', import.meta.url));
        worker.addEventListener('message', (event: MessageEvent<StatsReply>) => {
            const reply = event.data;
            if (reply === 'stopped') {
                this.#stopped.get(worker)?.();
                return;
            }
            const pending = this.#pending.get(reply.id);
            this.#pending.delete(reply.id);
            if (reply.ok) pending?.resolve(reply.value);
            else {
                pending?.reject(
                    reply.badQuery ? new BadQueryError(reply.message) : new Error(reply.message)
                );
            }
        });
        // The worker died: fail what it had, and start a fresh one on the next query.
        worker.addEventListener('error', event => {
            if (this.#worker === worker) this.#worker = null;
            this.#stopped.get(worker)?.();
            worker.terminate();
            this.#fail(new Error(`Stats worker failed: ${event.message}`));
        });
        worker.postMessage(init);
        this.#worker = worker;
        return worker;
    }

    #fail(error: Error): void {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
    }
}
