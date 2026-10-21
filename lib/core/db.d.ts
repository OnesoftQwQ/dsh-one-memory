/**
 * Minimal synchronous SQLite adapter.
 *
 * The core must run inside both the Node host (DSH) and the Bun host
 * (opencode), which ship different SQLite modules with the same shape:
 * `prepare(...).run/get/all` plus `exec`. `node:sqlite` is tried first and
 * `bun:sqlite` is the fallback, so the rest of the code never branches on the
 * runtime.
 *
 * @module one-memory/db
 */
/** One prepared statement. */
export interface DbStatement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
}
/** A synchronous SQLite connection. */
export interface Db {
    readonly kind: 'node' | 'bun';
    /** Absolute path of the database file. */
    readonly path: string;
    exec(sql: string): void;
    prepare(sql: string): DbStatement;
    close(): void;
}
/**
 * Open a database file, creating it when missing.
 * @param file - absolute path of the SQLite file.
 */
export declare function openDatabase(file: string): Db;
/**
 * Configure a connection for multi-process use. WAL lets the DSH and opencode
 * hosts read and write the same file; busy_timeout absorbs brief lock
 * contention instead of failing a write.
 * @param db - open connection.
 */
export declare function configureDatabase(db: Db): void;
/** Run a callback inside one immediate transaction. */
export declare function transaction<T>(db: Db, body: () => T): T;
/** Read a text column that may be null. */
export declare function text(value: unknown): string | undefined;
/** Read an integer column that may be null. */
export declare function integer(value: unknown): number | undefined;
/**
 * Create every table this plugin owns and record the schema version.
 * @param db - open connection.
 */
export declare function ensureSchema(db: Db): void;
/**
 * Seed the database from an earlier location when the target does not exist.
 * `VACUUM INTO` copies a consistent snapshot even while the old database is
 * still open in another host process.
 * @param target - database path to create.
 * @param candidates - earlier database paths, tried in order.
 * @returns the source path that was copied, or undefined.
 */
export declare function seedDatabase(target: string, candidates: readonly string[]): string | undefined;
