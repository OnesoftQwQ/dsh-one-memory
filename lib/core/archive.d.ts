/**
 * Cross-agent round archive, stored in the shared SQLite database.
 *
 * A round is one direct user message (or the round's steering messages) plus
 * the final assistant text. Tool calls, reasoning, injected context, and
 * intermediate assistant text are never archived, so the archive stays small
 * and host-neutral: recall and search read this table instead of another
 * framework's private session format.
 *
 * Rows are keyed by the unified session id from the session registry, so a
 * citation such as `[1](m-lq2x9d3f:12)` resolves the same way no matter which
 * agent produced it.
 *
 * @module one-memory/archive
 */
import { type Db } from './db.js';
/** One archived conversation round. */
export interface ArchivedRound {
    /** Producing host, for example `dsh` or `opencode`. */
    agent: string;
    /** Unified session id. */
    session: string;
    /** 1-based turn number as the host numbers it. */
    turn: number;
    /** Round start time (Unix epoch milliseconds). */
    time: number;
    /** Direct user messages of the round, in order. */
    user: string[];
    /** Final assistant text of the round; empty when the round had none. */
    answer: string;
    /** Optional host classification such as `subagent`. */
    origin?: string;
}
/** Archive construction options. */
export interface ArchiveOptions {
    /** Open connection, shared with the store and the session registry. */
    db: Db;
    /** Rounds kept per session; older rounds are dropped on overflow. */
    maxRoundsPerSession?: number;
    warn?: (message: string) => void;
}
/** One search hit over the archive. */
export interface ArchiveHit {
    round: ArchivedRound;
    score: number;
    matched: 'user' | 'assistant' | 'both';
    userExcerpt: string;
    assistantExcerpt: string;
}
/** One archived session summary. */
export interface ArchivedSession {
    agent: string;
    session: string;
    rounds: number;
    lastTime: number;
}
/** Durable round archive. */
export interface Archive {
    /** Append (or replace) one completed round. */
    append(round: ArchivedRound): void;
    /** Every archived round of one session, in turn order. */
    read(session: string): ArchivedRound[];
    /** Whether this session has any archived round. */
    has(session: string): boolean;
    /** Highest archived turn, or undefined for an empty archive file. */
    lastTurn(session: string): number | undefined;
    /** One round plus its neighbors. */
    slice(session: string, turn: number, before: number, after: number): {
        rounds: ArchivedRound[];
        found: boolean;
        turns: number[];
    };
    /** Literal search across sessions; newest rounds first on ties. */
    search(query: string, options?: {
        limit?: number;
        maxSessions?: number;
    }): ArchiveHit[];
    /** Archived sessions, newest activity first. */
    sessions(options?: {
        limit?: number;
    }): ArchivedSession[];
}
/**
 * Build the archive over an open database.
 * @param options - connection and retention.
 */
export declare function createArchive(options: ArchiveOptions): Archive;
