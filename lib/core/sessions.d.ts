/**
 * Session listing and message search.
 *
 * `session_list` is a zero-log-read listing: titles come from the live
 * projection registry or the persisted projection cache. `session_search`
 * prefers the SQLite FTS backend, restricts hits to `user/message` and
 * `assistant/message`, and maps each hit to its projected round. When the FTS
 * service is disabled or fails, it falls back to a literal scan of the most
 * recent sessions.
 *
 * @module one-memory/sessions
 */
import { type PluginContext, type SessionQueryLike, type SessionRecordLike } from './context.js';
/** One session-list row. */
export interface SessionListItem {
    id: string;
    title: string;
    createdAt: string;
    cwd?: string;
    live: boolean;
    persisted: boolean;
    origin?: string;
    parentSession?: string;
}
/** Result of `session_list`. */
export interface SessionListResult {
    sessions: SessionListItem[];
    total: number;
    matched: number;
    offset: number;
    limit: number;
    truncated: boolean;
}
/** One message search hit. */
export interface SessionSearchHit {
    sessionId: string;
    title: string;
    turn: number;
    time: string;
    matched: 'user' | 'assistant' | 'both';
    user: string;
    assistant: string;
}
/** Result of `session_search`. */
export interface SessionSearchResult {
    hits: SessionSearchHit[];
    scanned: number;
    errors: number;
    truncated: boolean;
    mode: 'fts' | 'literal';
}
/** List options. */
export interface SessionListOptions {
    query?: string;
    includeSubagents?: boolean;
    offset?: number;
    limit: number;
    signal?: AbortSignal;
}
/** Search options. */
export interface SessionSearchOptions {
    query: string;
    sessionId?: string;
    includeSubagents?: boolean;
    maxSessions: number;
    limit: number;
    signal?: AbortSignal;
}
/** Resolve one title from the live projection registry or the persisted cache. */
export declare function titleFor(ctx: PluginContext, record: SessionRecordLike): string | undefined;
/** Resolve titles for a bounded set of records, falling back to the query service. */
export declare function resolveTitles(ctx: PluginContext, sessionQuery: SessionQueryLike, records: readonly SessionRecordLike[], signal?: AbortSignal): Promise<Map<string, string>>;
/** List sessions, newest first, with cached titles. */
export declare function listSessions(ctx: PluginContext, sessionQuery: SessionQueryLike, options: SessionListOptions): Promise<SessionListResult>;
/** Search messages across recent sessions or one explicit session. */
export declare function searchSessions(ctx: PluginContext, sessionQuery: SessionQueryLike, options: SessionSearchOptions): Promise<SessionSearchResult>;
