import type { Database } from 'bun:sqlite';
import { availableParallelism } from 'node:os';

import type { StatsQuery } from '../shared/types.ts';
import type { StatsInit, StatsMethod, StatsReply, StatsRequest } from './stats-worker.ts';
import { BadQueryError, Stats } from './stats.ts';

type Run<M extends StatsMethod> = (...args: Parameters<Stats[M]>) => Promise<ReturnType<Stats[M]>>;
export type StatsQueries = { [M in StatsMethod]: Run<M> };

interface Job {
    request: StatsRequest;
    reply: PromiseWithResolvers<unknown>;
    signal: AbortSignal | undefined;
}

interface Slot {
    worker: Worker;
    /** The query it's answering; a worker takes one at a time. */
    job: Job | null;
    /** Asked to stop (idle too long, or shutting down); it takes no more queries. */
    retiring: boolean;
    idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface StatsReaderOptions {
    abuseMinScore: number;
    /** At most this many workers. Defaults to one per spare core, up to 4. */
    workers?: number;
    /** A worker with nothing to do for this long is stopped, freeing its connection. */
    idleMs?: number;
    /** The worker script (tests). */
    script?: URL;
}

/** One per core the server's own thread doesn't use, up to 4: each holds a connection. */
const defaultWorkers = () => Math.max(1, Math.min(4, availableParallelism() - 1));

/**
 * The dashboard's stats, queried in a few Workers (see stats-worker.ts) so a slow query
 * over many clicks doesn't hold up redirects, and a refresh's queries run side by side.
 * Workers start as queries need them and stop after a while with none, since each
 * holds a connection with its own cache. An in-memory database (tests) can't be opened
 * from another thread, so it's queried here. The CSV export stays here too: it reads a
 * page at a time and lets redirects run between pages.
 */
export class StatsReader {
    readonly #stats: Stats;
    readonly #init: StatsInit | null;
    readonly #size: number;
    readonly #idleMs: number;
    readonly #script: URL;
    readonly #slots = new Set<Slot>();
    /** Queries waiting for a free worker, oldest first. */
    readonly #queue: Job[] = [];
    #closed = false;
    #drained: PromiseWithResolvers<void> | null = null;
    #next = 0;

    constructor(db: Database, opts: StatsReaderOptions) {
        this.#stats = new Stats(db, opts);
        const file = db.filename;
        this.#init =
            file === ':memory:' || file === '' ? null : { file, abuseMinScore: opts.abuseMinScore };
        this.#size = Math.max(1, opts.workers ?? defaultWorkers());
        this.#idleMs = opts.idleMs ?? 60_000;
        this.#script = opts.script ?? new URL('stats-worker.ts', import.meta.url);
    }

    /** Workers running now (tests). */
    get workers(): number {
        return this.#slots.size;
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
     * Answers the queries already asked, then closes each worker's connection (so the
     * database file isn't held open) and ends the workers. Queries after this are refused.
     */
    async stop(): Promise<void> {
        if (!this.#closed) {
            this.#closed = true;
            this.#drained = Promise.withResolvers();
            for (const slot of this.#slots) if (!slot.job) this.#retire(slot);
            this.#checkDrained();
        }
        await this.#drained?.promise;
    }

    /**
     * The same queries, for a request that may go away: once `signal` aborts, a query
     * still waiting for a worker is dropped (rejected with the signal's reason) rather
     * than run. One a worker has started runs to the end; SQLite can't be stopped from
     * another thread.
     */
    for(signal: AbortSignal): StatsQueries {
        return {
            summary: (...args) => this.#run('summary', args, signal),
            timeseries: (...args) => this.#run('timeseries', args, signal),
            top: (...args) => this.#run('top', args, signal),
            suggest: (...args) => this.#run('suggest', args, signal),
            history: (...args) => this.#run('history', args, signal)
        };
    }

    #run<M extends StatsMethod>(
        method: M,
        args: Parameters<Stats[M]>,
        signal?: AbortSignal
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
        const job: Job = {
            request: { id: this.#next++, method, args },
            reply: Promise.withResolvers<unknown>(),
            signal
        };
        this.#queue.push(job);
        this.#pump();
        return job.reply.promise as Promise<ReturnType<Stats[M]>>;
    }

    /** Hands waiting queries to idle workers, starting workers up to the pool's size. */
    #pump(): void {
        for (let job = this.#queue[0]; job; job = this.#queue[0]) {
            // Nobody is waiting for it any more (the dashboard moved on, or the tab closed).
            if (job.signal?.aborted) {
                this.#queue.shift();
                job.reply.reject(job.signal.reason);
                continue;
            }
            const slot = this.#idleSlot() ?? this.#spawn();
            if (!slot) break;
            this.#queue.shift();
            if (slot.idleTimer) clearTimeout(slot.idleTimer);
            slot.idleTimer = null;
            slot.job = job;
            slot.worker.postMessage(job.request);
        }
        this.#checkDrained();
    }

    #idleSlot(): Slot | null {
        for (const slot of this.#slots) if (!slot.job && !slot.retiring) return slot;
        return null;
    }

    #spawn(): Slot | null {
        let working = 0;
        for (const slot of this.#slots) if (!slot.retiring) working++;
        if (!this.#init || working >= this.#size) return null;
        const worker = new Worker(this.#script);
        const slot: Slot = { worker, job: null, retiring: false, idleTimer: null };
        worker.addEventListener('message', (event: MessageEvent<StatsReply>) => {
            // Already removed (it died); a late reply has no one to go to.
            if (!this.#slots.has(slot)) return;
            const reply = event.data;
            if (reply === 'stopped') {
                this.#remove(slot);
                return;
            }
            const job = slot.job;
            slot.job = null;
            if (job?.request.id === reply.id) {
                if (reply.ok) job.reply.resolve(reply.value);
                else {
                    job.reply.reject(
                        reply.badQuery ? new BadQueryError(reply.message) : new Error(reply.message)
                    );
                }
            }
            this.#pump();
            if (slot.job || slot.retiring) return;
            if (this.#closed) this.#retire(slot);
            else {
                slot.idleTimer = setTimeout(() => this.#retire(slot), this.#idleMs);
                slot.idleTimer.unref();
            }
        });
        worker.addEventListener('error', event => {
            this.#lost(slot, `Stats worker failed: ${event.message}`);
        });
        // Ended without being asked to (an error ends it with `error` first).
        worker.addEventListener('close', () => {
            this.#lost(slot, 'Stats worker exited');
        });
        worker.postMessage(this.#init);
        this.#slots.add(slot);
        return slot;
    }

    /** The worker died: fail its query, and let a fresh one take the queries waiting. */
    #lost(slot: Slot, message: string): void {
        if (!this.#slots.has(slot)) return;
        slot.job?.reply.reject(new Error(message));
        slot.job = null;
        this.#remove(slot);
        this.#pump();
    }

    /** Asks an idle worker to close its connection; it's removed once it has. */
    #retire(slot: Slot): void {
        if (slot.retiring) return;
        slot.retiring = true;
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        slot.idleTimer = null;
        slot.worker.postMessage('stop');
    }

    #remove(slot: Slot): void {
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        slot.worker.terminate();
        this.#slots.delete(slot);
        this.#checkDrained();
    }

    #checkDrained(): void {
        if (this.#closed && this.#slots.size === 0 && this.#queue.length === 0) {
            this.#drained?.resolve();
        }
    }
}
