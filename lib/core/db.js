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
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
let cachedRequire;
function runtimeRequire() {
    cachedRequire ??= createRequire(import.meta.url);
    return cachedRequire;
}
/**
 * Open a database file, creating it when missing.
 * @param file - absolute path of the SQLite file.
 */
export function openDatabase(file) {
    const require = runtimeRequire();
    const db = openDiagnosed(require, file);
    // SQLite creates the file and its WAL siblings with the process umask; the
    // database holds every memory and archived round, so it stays owner-only.
    for (const target of [file, `${file}-wal`, `${file}-shm`]) {
        try {
            chmodSync(target, 0o600);
        }
        catch {
            // A missing sibling or a filesystem without chmod is fine.
        }
    }
    return db;
}
function openDiagnosed(require, file) {
    try {
        const module = require('node:sqlite');
        const connection = new module.DatabaseSync(file);
        return {
            kind: 'node',
            path: file,
            exec: (sql) => connection.exec(sql),
            prepare: (sql) => connection.prepare(sql),
            close: () => connection.close()
        };
    }
    catch (nodeError) {
        try {
            const module = require('bun:sqlite');
            const connection = new module.Database(file, { create: true });
            return {
                kind: 'bun',
                path: file,
                exec: (sql) => connection.exec(sql),
                prepare: (sql) => connection.prepare(sql),
                close: () => connection.close()
            };
        }
        catch {
            throw new Error(`no SQLite runtime available (node:sqlite: ${String(nodeError)}); Node >= 22.5 or Bun is required`);
        }
    }
}
/**
 * Configure a connection for multi-process use. WAL lets the DSH and opencode
 * hosts read and write the same file; busy_timeout absorbs brief lock
 * contention instead of failing a write.
 * @param db - open connection.
 */
export function configureDatabase(db) {
    try {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
        db.exec('PRAGMA busy_timeout = 5000');
    }
    catch {
        // A read-only or exotic filesystem keeps the defaults.
    }
}
/** Run a callback inside one immediate transaction. */
export function transaction(db, body) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const value = body();
        db.exec('COMMIT');
        return value;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // Best effort: the original failure is the useful one.
        }
        throw error;
    }
}
/** Read a text column that may be null. */
export function text(value) {
    return typeof value === 'string' ? value : undefined;
}
/** Read an integer column that may be null. */
export function integer(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return value;
    if (typeof value === 'bigint')
        return Number(value);
    return undefined;
}
const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entry (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	description TEXT,
	source_session TEXT,
	source_turn INTEGER,
	source_conversation TEXT,
	revision INTEGER NOT NULL,
	created_revision INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_tombstone (
	key TEXT PRIMARY KEY,
	revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_entry_revision ON memory_entry(revision);
CREATE TABLE IF NOT EXISTS memory_session (
	id TEXT PRIMARY KEY,
	agent TEXT NOT NULL,
	native_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	title TEXT,
	UNIQUE(agent, native_id)
);
CREATE TABLE IF NOT EXISTS round (
	agent TEXT NOT NULL,
	session TEXT NOT NULL,
	turn INTEGER NOT NULL,
	time INTEGER NOT NULL,
	user_text TEXT NOT NULL,
	answer TEXT NOT NULL,
	search_text TEXT NOT NULL,
	origin TEXT,
	PRIMARY KEY (agent, session, turn)
);
CREATE INDEX IF NOT EXISTS round_session ON round(agent, session, turn);
CREATE INDEX IF NOT EXISTS round_time ON round(time);
`;
/**
 * Create every table this plugin owns and record the schema version.
 * @param db - open connection.
 */
export function ensureSchema(db) {
    db.exec(SCHEMA);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (text(row?.value) === undefined) {
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    }
}
/**
 * Seed the database from an earlier location when the target does not exist.
 * `VACUUM INTO` copies a consistent snapshot even while the old database is
 * still open in another host process.
 * @param target - database path to create.
 * @param candidates - earlier database paths, tried in order.
 * @returns the source path that was copied, or undefined.
 */
export function seedDatabase(target, candidates) {
    if (existsSync(target))
        return undefined;
    for (const candidate of candidates) {
        if (candidate === target || !existsSync(candidate))
            continue;
        let source;
        try {
            source = openDatabase(candidate);
            mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
            try {
                rmSync(target, { force: true });
            }
            catch {
                // The VACUUM INTO below reports a real failure.
            }
            source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
            return candidate;
        }
        catch {
            continue;
        }
        finally {
            try {
                source?.close();
            }
            catch {
                // Best effort.
            }
        }
    }
    return undefined;
}
