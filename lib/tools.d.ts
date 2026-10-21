/**
 * Model-facing memory, recall, and session tools.
 *
 * @module one-memory/tools
 */
import type { PluginContext } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import { type MemoryStore } from './core/store.js';
import type { Archive } from './core/archive.js';
import type { SessionRegistry } from './core/sessions-registry.js';
/** A model-facing tool failure with a stable code in the message. */
export declare class MemoryToolError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/** Install all model-facing tools. */
export declare function installTools(ctx: PluginContext, store: MemoryStore, archive: Archive, registry: SessionRegistry, config: MemoryConfig): void;
