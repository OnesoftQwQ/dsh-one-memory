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

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	legacyDatabasePaths,
	legacyStorePath,
	normalizeConfig,
	type MemoryConfig
} from './core/config.js';
import { createMemoryStore } from './core/store.js';
import { createArchive } from './core/archive.js';
import { createSessionRegistry } from './core/sessions-registry.js';
import { configureDatabase, ensureSchema, openDatabase, seedDatabase } from './core/db.js';
import { backfillSession, installArchiveWriter } from './archive-writer.js';
import { installInjection } from './inject.js';
import { installTools } from './tools.js';
import { installWeb } from './web.js';
import type { AgentLike, PluginContext } from './core/context.js';

/** Plugin identity for the profile composition. */
export const name = 'one-memory';

/** The tool registry is required; every other service is optional. */
export const inject = ['tools'];

/**
 * Install the plugin.
 * @param ctx - the mounting Cordis context.
 * @param rawConfig - resolved plugin configuration.
 */
export function apply(ctx: PluginContext, rawConfig?: Record<string, unknown>): void {
	const config = normalizeConfig(rawConfig);
	migrateLegacyStore(ctx, config);
	mkdirSync(dirname(config.databaseFile), { recursive: true, mode: 0o700 });
	const seeded = seedDatabase(config.databaseFile, legacyDatabasePaths());
	if (seeded !== undefined) {
		ctx.logger.info?.(`[one-memory] migrated database from ${seeded}`);
	}
	const db = openDatabase(config.databaseFile);
	configureDatabase(db);
	ensureSchema(db);
	const store = createMemoryStore({
		db,
		maxEntries: config.maxEntries,
		maxCatalogChars: config.maxCatalogChars,
		maxDeltaChars: config.maxDeltaChars,
		deltaValueChars: config.deltaValueChars,
		legacyFile: legacyStorePath(),
		warn: (message) => ctx.logger.warn?.(message)
	});
	const archive = createArchive({
		db,
		maxRoundsPerSession: config.maxRoundsPerSession,
		warn: (message) => ctx.logger.warn?.(message)
	});
	const registry = createSessionRegistry(db);
	installTools(ctx, store, archive, registry, config);
	installInjection(ctx, store, registry, config);
	installWeb(ctx, store, config);
	installArchiveWriter(ctx, archive, registry, config);
	if (config.archive) {
		ctx.effect(() =>
			ctx.on('agent/created', (payload: { agent?: AgentLike }) => {
				void backfillSession(ctx, archive, registry, config, payload?.agent).catch(
					(error: unknown) => {
						ctx.logger.warn?.(`[one-memory] backfill task failed: ${String(error)}`);
					}
				);
			})
		);
	}
	const systemPrompt = ctx.get('systemPrompt') as
		| { section(entry: { name: string; order: number; text: string }): unknown }
		| undefined;
	if (systemPrompt !== undefined && config.guidance.trim() !== '') {
		ctx.effect(() =>
			systemPrompt.section({
				name: 'tool:agent-memory',
				order: 2350,
				text: config.guidance
			})
		);
	}
	ctx.logger.info?.(
		`[one-memory] ready (db=${config.databaseFile}, archive=${config.archive ? 'on' : 'off'})`
	);
}

/**
 * Copy the pre-0.3 JSON store out of the way. The database import reads the
 * legacy file itself; this only guarantees a copy survives in the shared root.
 */
function migrateLegacyStore(ctx: PluginContext, config: MemoryConfig): void {
	const legacy = legacyStorePath();
	if (!existsSync(legacy)) return;
	const copy = `${legacy}.pre-sqlite.json`;
	if (existsSync(copy)) return;
	try {
		copyFileSync(legacy, copy);
		ctx.logger.info?.(`[one-memory] kept a pre-SQLite copy at ${copy}`);
	} catch (error) {
		ctx.logger.warn?.(`[one-memory] legacy backup failed: ${String(error)}`);
	}
}

export { createMemoryStore } from './core/store.js';
export { createArchive } from './core/archive.js';
export { createSessionRegistry } from './core/sessions-registry.js';
export { normalizeConfig, DEFAULT_GUIDANCE, legacyStorePath } from './core/config.js';
export type { MemoryConfig } from './core/config.js';
export type { MemoryEntry, MemoryEntryView, MemoryStore } from './core/store.js';
export type { Archive, ArchivedRound, ArchiveHit } from './core/archive.js';
export type { RegisteredSession, SessionRegistry } from './core/sessions-registry.js';
