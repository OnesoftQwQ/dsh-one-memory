import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, openEnv } from './helpers.mjs';
import { MemoryLimitError } from '../lib/core/store.js';

test('store round-trips entries, global memory, and catalog', () => {
	const dir = tempDir();
	const { store } = openEnv(dir);
	const created = store.set('project/build', { value: 'pnpm build', description: 'build command' });
	assert.equal(created.created, true);
	store.set('@global', { value: 'global notes' });

	const snapshot = store.snapshot();
	assert.equal(snapshot.global?.value, 'global notes');
	assert.deepEqual(snapshot.catalog, [{ key: 'project/build', description: 'build command' }]);
	assert.equal(store.get('project/build').value, 'pnpm build');
	assert.equal(store.delete('project/build'), true);
	assert.equal(store.delete('project/build'), false);
	assert.equal(store.get('project/build'), undefined);
	rmSync(dir, { recursive: true, force: true });
});

test('store enforces the key budget and truncates the catalog', () => {
	const dir = tempDir();
	const { store } = openEnv(dir, { maxEntries: 2, maxCatalogChars: 10 });
	store.set('a', { value: '1', description: 'first' });
	store.set('b', { value: '2' });
	assert.throws(() => store.set('c', { value: '3' }), MemoryLimitError);
	const rendered = store.render('m-test');
	assert.ok(rendered !== undefined);
	assert.match(rendered.text, /<memory-keys>/);
	assert.match(rendered.text, /more keys/);
	assert.match(rendered.text, /Current session: m-test/);
	rmSync(dir, { recursive: true, force: true });
});

test('store returns no session-start block when both memories are empty', () => {
	const dir = tempDir();
	const { store } = openEnv(dir);
	assert.equal(store.render('m-test'), undefined);
	rmSync(dir, { recursive: true, force: true });
});

test('store survives a reopen with the same data', () => {
	const dir = tempDir();
	const first = openEnv(dir);
	first.store.set('a', { value: '1' });
	first.db.close();
	const second = openEnv(dir);
	assert.equal(second.store.get('a').value, '1');
	assert.equal(second.store.revision(), 1);
	second.db.close();
	rmSync(dir, { recursive: true, force: true });
});

test('source fields can be cleared and entries exclude deleted keys', () => {
	const dir = tempDir();
	const { store } = openEnv(dir);
	store.set('a', { value: '1', description: 'd', sourceSession: 's', sourceTurn: 1 });
	store.set('a', { value: '2', description: null, sourceSession: null, sourceTurn: null });
	const entry = store.get('a');
	assert.equal(entry.value, '2');
	assert.equal(entry.description, undefined);
	assert.equal(entry.sourceSession, undefined);
	store.delete('a');
	assert.deepEqual(store.entries(), []);
	rmSync(dir, { recursive: true, force: true });
});

test('revision tracks changes and classifies deltas', () => {
	const dir = tempDir();
	const { store } = openEnv(dir);
	assert.equal(store.set('a', { value: 'one', description: 'A' }).revision, 1);
	assert.equal(store.set('b', { value: 'two' }).revision, 2);
	assert.equal(store.set('@global', { value: 'g1' }).revision, 3);
	const from = store.revision();
	assert.equal(store.set('a', { value: 'uno' }).revision, 4);
	assert.equal(store.set('c', { value: 'three' }).revision, 5);
	assert.equal(store.delete('b'), true);
	assert.equal(store.set('@global', { value: 'g2' }).revision, 7);

	const delta = store.changesSince(from);
	assert.equal(delta.revision, 7);
	assert.equal(delta.global.value, 'g2');
	assert.deepEqual(
		delta.entries.map((entry) => [entry.key, entry.kind]),
		[
			['a', 'updated'],
			['c', 'added']
		]
	);
	assert.deepEqual(delta.removed, ['b']);
	const rendered = store.renderDelta(delta);
	assert.ok(rendered !== undefined);
	assert.match(rendered.text, /replaces the earlier global memory/);
	assert.match(rendered.text, /~ a — A: uno/);
	assert.match(rendered.text, /\+ c: three/);
	assert.match(rendered.text, /- b/);
	rmSync(dir, { recursive: true, force: true });
});

test('a no-op set does not advance the revision', () => {
	const dir = tempDir();
	const { store } = openEnv(dir);
	store.set('a', { value: '1', description: 'd' });
	const revision = store.revision();
	assert.equal(store.set('a', { value: '1', description: 'd' }).revision, revision);
	assert.equal(store.revision(), revision);
	rmSync(dir, { recursive: true, force: true });
});

test('tombstones survive reopen and appear in deltas', () => {
	const dir = tempDir();
	const first = openEnv(dir);
	first.store.set('a', { value: '1' });
	const revision = first.store.revision();
	first.store.delete('a');
	first.db.close();
	const second = openEnv(dir);
	assert.equal(second.store.revision(), revision + 1);
	assert.deepEqual(second.store.changesSince(revision).removed, ['a']);
	second.db.close();
	rmSync(dir, { recursive: true, force: true });
});

test('a legacy memory.json is imported once', () => {
	const dir = tempDir();
	const legacy = join(dir, 'memory.json');
	writeFileSync(
		legacy,
		JSON.stringify({
			version: 1,
			revision: 5,
			tombstones: { gone: 4 },
			entries: {
				'@global': { value: 'legacy global', revision: 2, createdRevision: 1, createdAt: 1, updatedAt: 2 },
				old: { value: 'old fact', description: 'd', revision: 5, createdRevision: 2, createdAt: 1, updatedAt: 2 }
			}
		})
	);
	const { store } = openEnv(dir, { legacyFile: legacy });
	assert.equal(store.get('@global').value, 'legacy global');
	assert.equal(store.get('old').value, 'old fact');
	assert.equal(store.revision(), 5);
	assert.deepEqual(store.changesSince(3).removed, ['gone']);
	rmSync(dir, { recursive: true, force: true });
});

test('renderDelta caps long values and many changes', () => {
	const dir = tempDir();
	const { store } = openEnv(dir, { maxDeltaChars: 220, deltaValueChars: 20 });
	store.set('a', { value: 'x'.repeat(100) });
	const from = store.revision();
	store.set('b', { value: 'y'.repeat(100) });
	store.set('c', { value: 'z'.repeat(100) });
	store.set('d', { value: 'w'.repeat(100) });
	const rendered = store.renderDelta(store.changesSince(from));
	assert.ok(rendered !== undefined);
	assert.match(rendered.text, /more changes|truncated|use memory_get/);
	rmSync(dir, { recursive: true, force: true });
});
