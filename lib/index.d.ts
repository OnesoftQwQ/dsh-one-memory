/**
 * `dsh-one-memory` — manually managed global and key-value memory with an
 * archive of completed rounds, unified session ids, original-round recall, and
 * session browsing.
 *
 * The plugin is Host-only and imports no Harness runtime package: Host
 * services are reached through `ctx.get()`, so installation does not depend on
 * the Host's module resolution.
 *
 * @module dsh-one-memory
 */
import type { PluginContext } from './core/context.js';
/** Plugin identity for the profile composition. */
export declare const name = "one-memory";
/** The tool registry is required; every other service is optional. */
export declare const inject: string[];
/**
 * Install the plugin.
 * @param ctx - the mounting Cordis context.
 * @param rawConfig - resolved plugin configuration.
 */
export declare function apply(ctx: PluginContext, rawConfig?: Record<string, unknown>): void;
export { createMemoryStore } from './core/store.js';
export { createArchive } from './core/archive.js';
export { createSessionRegistry } from './core/sessions-registry.js';
export { normalizeConfig, DEFAULT_GUIDANCE, legacyStorePath } from './core/config.js';
export type { MemoryConfig } from './core/config.js';
export type { MemoryEntry, MemoryEntryView, MemoryStore } from './core/store.js';
export type { Archive, ArchivedRound, ArchiveHit } from './core/archive.js';
export type { RegisteredSession, SessionRegistry } from './core/sessions-registry.js';
