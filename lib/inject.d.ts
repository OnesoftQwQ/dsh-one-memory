/**
 * Session-start baseline, incremental memory updates, and the per-turn
 * session/turn context.
 *
 * The listener runs at the first step of every turn. It compares the latest
 * memory revision in the store with the highest revision the model has
 * already seen in this session:
 *
 * - no visible baseline (new session, resume without history, after a
 *   compaction that shadowed it) -> inject the full global memory + key
 *   catalog + the current turn;
 * - a visible baseline but a newer store revision -> inject only the changed
 *   global memory, the added/updated/removed key list, and the current turn;
 * - same revision -> inject only `Current session` / `Current turn`.
 *
 * Because the revision lives in the shared JSON store, a change made by
 * session A is delivered to session B on B's next turn, without a restart.
 *
 * @module one-memory/inject
 */
import type { PluginContext } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import type { MemoryStore } from './core/store.js';
import type { SessionRegistry } from './core/sessions-registry.js';
/**
 * Install the `agent/pre-step` listener.
 */
export declare function installInjection(ctx: PluginContext, store: MemoryStore, registry: SessionRegistry, config: MemoryConfig): void;
