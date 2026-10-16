/** A malformed stats query or search: the API answers 400 with its message. */
export class BadQueryError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadQueryError';
    }
}
