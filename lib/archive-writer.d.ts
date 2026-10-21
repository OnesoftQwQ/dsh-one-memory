/**
 * DSH-side archive writer.
 *
 * The writer listens to the post-commit `session/event` feed and buffers the
 * events of the open turn. When `turn/end` arrives it projects that turn with
 * the same rules as `memory_recall` (direct user messages plus the final
 * assistant text), resolves the unified session id, appends one archive row,
 * and clears the buffer.
 *
 * Subagent sessions are skipped: their rounds belong to a delegated task, not
 * to the user's own conversation history.
 *
 * @module one-memory/archive-writer
 */
import type { AgentLike, PluginContext } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import type { Archive } from './core/archive.js';
import type { SessionRegistry } from './core/sessions-registry.js';
/** Install the live archive writer. */
export declare function installArchiveWriter(ctx: PluginContext, archive: Archive, registry: SessionRegistry, config: MemoryConfig): void;
/**
 * Backfill one session from its native log when the archive has no row for it.
 * Called when an agent is created, which covers a restart and a plugin
 * installed after the session began.
 */
export declare function backfillSession(ctx: PluginContext, archive: Archive, registry: SessionRegistry, config: MemoryConfig, agent: AgentLike | undefined): Promise<number>;
