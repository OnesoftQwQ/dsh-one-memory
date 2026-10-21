/**
 * Configuration for the one-memory plugin.
 *
 * @module one-memory/config
 */
/** Resolved runtime configuration. */
export interface MemoryConfig {
    /** Shared storage root, default `~/.agents/one-memory`. */
    root: string;
    /** Directory containing `memory.json`. */
    dir: string;
    /** Absolute path of the legacy JSON store (migration source only). */
    file: string;
    /** Absolute path of the shared SQLite database. */
    databaseFile: string;
    /** Directory holding the per-agent round archives. */
    archiveDir: string;
    /** Record completed rounds into the archive. */
    archive: boolean;
    /** Backfill a session from its native log when the archive has no file for it. */
    archiveBackfill: boolean;
    /** Rounds kept per session file; older rounds are dropped when exceeded. */
    maxRoundsPerSession: number;
    /** Cap for the global (`@global`) memory text. */
    maxGlobalChars: number;
    /** Cap for one ordinary memory value. */
    maxEntryChars: number;
    /** Cap for the number of ordinary memory keys. */
    maxEntries: number;
    /** Cap for the rendered key catalog injected at session start. */
    maxCatalogChars: number;
    /** Cap for one `memory_recall` transcript. */
    maxRecallChars: number;
    /** Cap for one incremental memory-update message. */
    maxDeltaChars: number;
    /** Per-value cap inside an incremental update list. */
    deltaValueChars: number;
    /** Default session count scanned by a global `session_search`. */
    maxSessionScan: number;
    /** Default page size for `session_list`. */
    sessionListLimit: number;
    /** Default hit count for `session_search`. */
    searchLimit: number;
    /** Inject the global memory and key catalog at session start. */
    injectGlobal: boolean;
    /** Also inject into subagent sessions. */
    injectGlobalInSubagents: boolean;
    /** Allow subagent sessions to write memory. */
    allowSubagentWrites: boolean;
    /** System-prompt guidance; empty string disables it. */
    guidance: string;
}
/** Default guidance appended to the system prompt. */
export declare const DEFAULT_GUIDANCE: string;
/**
 * Resolve the plugin config. Unknown or invalid values fall back to defaults.
 * @param raw - config object from the Cordis row.
 * @param env - environment, injectable for tests.
 */
export declare function normalizeConfig(raw?: Record<string, unknown>, env?: NodeJS.ProcessEnv): MemoryConfig;
/** Earlier database locations, in migration order. */
export declare function legacyDatabasePaths(env?: NodeJS.ProcessEnv): string[];
/** Where the pre-0.3 plugin kept its store; used for the one-time import. */
export declare function legacyStorePath(env?: NodeJS.ProcessEnv): string;
