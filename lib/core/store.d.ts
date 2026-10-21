/**
 * SQLite-backed memory store.
 *
 * One file holds the curated memory (global + key-value), its monotonic
 * revision, and deletion tombstones, so every write is one transaction and a
 * second host process reading the same file sees a consistent state. A legacy
 * `memory.json` is imported once when the database is first created.
 *
 * @module one-memory/store
 */
import { type Db } from './db.js';
/** One stored memory. `@global` is a reserved key. */
export interface MemoryEntry {
    value: string;
    description?: string;
    sourceSession?: string;
    sourceTurn?: number;
    sourceConversation?: string;
    createdAt: number;
    updatedAt: number;
    /** Monotonic revision of the latest change. */
    revision?: number;
    /** Revision at which this key was created. */
    createdRevision?: number;
}
/** One entry as shown by the management UI. */
export interface MemoryEntryView {
    key: string;
    value: string;
    description?: string;
    revision?: number;
    createdAt: number;
    updatedAt: number;
}
/** One key-catalog item. */
export interface CatalogItem {
    key: string;
    description?: string;
}
/** A read-only view of the current store. */
export interface StoreSnapshot {
    revision: number;
    global: MemoryEntry | undefined;
    catalog: CatalogItem[];
    version: string;
}
/** One changed entry in a delta. */
export interface MemoryChange {
    key: string;
    entry: MemoryEntry;
    kind: 'added' | 'updated';
}
/** Changes since one revision. */
export interface MemoryDelta {
    fromRevision: number;
    revision: number;
    /** New global value, when it changed. */
    global: MemoryEntry | undefined;
    /** Whether the global memory was removed. */
    globalRemoved: boolean;
    entries: MemoryChange[];
    removed: string[];
}
/** Input for one upsert. `undefined` keeps an existing field; `null` clears it. */
export interface SetInput {
    value: string;
    description?: string | null;
    sourceSession?: string | null;
    sourceTurn?: number | null;
    sourceConversation?: string | null;
}
/** Rendered session-start baseline. */
export interface RenderedMemory {
    text: string;
    sections: Array<{
        name: string;
        text: string;
    }>;
    version: string;
    revision: number;
}
/** Rendered incremental update. */
export interface RenderedDelta {
    text: string;
    sections: Array<{
        name: string;
        text: string;
    }>;
    revision: number;
    fromRevision: number;
}
/** Store construction options. */
export interface StoreOptions {
    /** Open SQLite connection, shared with the archive. */
    db: Db;
    maxEntries: number;
    maxCatalogChars: number;
    /** Cap for one delta message; defaults to 6000. */
    maxDeltaChars?: number;
    /** Per-value cap inside a delta list; defaults to 600. */
    deltaValueChars?: number;
    /** Legacy `memory.json` imported once when the database is empty. */
    legacyFile?: string;
    warn?: (message: string) => void;
}
/** Durable memory store. */
export interface MemoryStore {
    readonly path: string;
    snapshot(): StoreSnapshot;
    /** Every entry including `@global`, sorted by key. */
    entries(): MemoryEntryView[];
    revision(): number;
    get(key: string): MemoryEntry | undefined;
    set(key: string, input: SetInput): {
        created: boolean;
        entry: MemoryEntry;
        revision: number;
    };
    delete(key: string): boolean;
    changesSince(revision: number): MemoryDelta;
    render(sessionId?: string): RenderedMemory | undefined;
    renderDelta(delta: MemoryDelta): RenderedDelta | undefined;
    version(): string;
}
/** Thrown when the ordinary-key budget is exhausted. */
export declare class MemoryLimitError extends Error {
    constructor(message: string);
}
/** The reserved global-memory key. */
export declare const GLOBAL_KEY = "@global";
/**
 * Open the store, creating the schema on first use.
 * @param options - database path, limits, and optional legacy import.
 */
export declare function createMemoryStore(options: StoreOptions): MemoryStore;
