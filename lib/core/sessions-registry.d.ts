/**
 * Unified session registry.
 *
 * Each host keeps its own session ids (`session-<uuid>` in DSH, `ses_…` in
 * opencode). The memory plugin assigns one short, host-neutral id per
 * conversation and stores the mapping, so archive rows, citations, and tool
 * calls all use the same identifier regardless of which agent produced them.
 *
 * @module one-memory/sessions-registry
 */
import { type Db } from './db.js';
/** One registered conversation. */
export interface RegisteredSession {
    /** Unified id, for example `m-lq2x9d3f`. */
    id: string;
    /** Producing host. */
    agent: string;
    /** The host's own session id. */
    nativeId: string;
    createdAt: number;
    lastSeen: number;
    title?: string;
}
/** Unified session registry. */
export interface SessionRegistry {
    /** Return the existing unified id for (agent, nativeId), creating one when absent. */
    ensure(agent: string, nativeId: string): RegisteredSession;
    /** Resolve a unified id or any host's native id. */
    resolve(raw: string): RegisteredSession | undefined;
    /** Record activity so listings sort by real use. */
    touch(id: string): void;
    /** Store a display title when the host knows one. */
    setTitle(id: string, title: string): void;
    /** All registered sessions, newest first. */
    list(limit?: number): RegisteredSession[];
    /** The unified id of one session without creating it. */
    find(agent: string, nativeId: string): RegisteredSession | undefined;
}
/**
 * Build the registry over an open database.
 * @param db - open connection with the schema applied.
 */
export declare function createSessionRegistry(db: Db): SessionRegistry;
