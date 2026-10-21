// Shared test helpers: one temporary SQLite database per test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDatabase, ensureSchema, openDatabase } from '../lib/core/db.js';
import { createMemoryStore } from '../lib/core/store.js';
import { createArchive } from '../lib/core/archive.js';
import { createSessionRegistry } from '../lib/core/sessions-registry.js';

export function tempDir() {
	return mkdtempSync(join(tmpdir(), 'agent-memory-test-'));
}

export function openEnv(dir, options = {}) {
	const db = openDatabase(join(dir, 'agent-memory.db'));
	configureDatabase(db);
	ensureSchema(db);
	const store = createMemoryStore({
		db,
		maxEntries: options.maxEntries ?? 50,
		maxCatalogChars: options.maxCatalogChars ?? 2000,
		maxDeltaChars: options.maxDeltaChars ?? 6000,
		deltaValueChars: options.deltaValueChars ?? 600,
		legacyFile: options.legacyFile,
		warn: options.warn
	});
	const archive = createArchive({
		db,
		maxRoundsPerSession: options.maxRoundsPerSession ?? 2000,
		warn: options.warn
	});
	const registry = createSessionRegistry(db);
	return { db, store, archive, registry, dir };
}
