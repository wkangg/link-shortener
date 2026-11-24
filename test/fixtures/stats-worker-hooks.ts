// Listens before the real stats worker (see stats-worker.ts): `crash!` ends the worker
// mid-query, and `slow!` holds it for SLOW_MS and then lets it answer with no search.
import type { StatsRequest } from '../../src/analytics/stats-worker.ts';

declare const self: Worker;

const SLOW_MS = 300; // test/stats-reader.test.ts waits on this too

self.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as Partial<StatsRequest> | null;
    const query = data?.args?.[0] as { q?: string } | undefined;
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- a thrown error would leave the file open on Windows
    if (query?.q === 'crash!') process.exit(1);
    if (query?.q !== 'slow!') return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SLOW_MS);
    // The real worker, listening next, then answers it as if there were no search.
    delete query.q;
});
