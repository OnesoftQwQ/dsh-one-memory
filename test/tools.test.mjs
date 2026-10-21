import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTools } from '../lib/tools.js';
import { normalizeConfig } from '../lib/core/config.js';
import { tempDir, openEnv } from './helpers.mjs';

const HEADER = { id: 's1', createdAt: 100, cwd: '/repo' };

function fixtureEvents() {
	return [
		{ seq: 0, time: 1000, type: 'turn/start', data: { turn: 3 } },
		{
			seq: 1,
			time: 1001,
			type: 'user/message',
			data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'build?' }] }
		},
		{ seq: 2, time: 1002, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
		{
			seq: 3,
			time: 1003,
			type: 'tool/result',
			data: { message: { content: [{ type: 'text', text: 'ok' }] } }
		},
		{
			seq: 4,
			time: 1004,
			type: 'assistant/message',
			data: { message: { content: [{ type: 'text', text: 'pnpm build' }] } }
		},
		{ seq: 5, time: 1005, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
	];
}

function service(overrides = {}) {
	return {
		listSessions: async () => [{ header: HEADER, live: true, persisted: true }],
		readSession: async () => ({ session: HEADER, events: fixtureEvents() }),
		readTitle: async () => ({ title: 'Build script', eventSeq: 0, updatedAt: 0 }),
		readTitleSnapshots: async (ids) =>
			ids.map((id) => ({
				sessionId: id,
				status: 'fulfilled',
				value: { title: { title: 'Build script' } }
			})),
		listEvents: async () => [{ sessionId: 's1', seq: 0, type: 'turn/start', time: 1000, surface: 'log-only' }],
		readEvent: async () => ({
			target: { seq: 0, time: 1000, type: 'turn/start', data: { turn: 3 } },
			events: []
		}),
		searchSessions: async () => ({
			items: [{ header: HEADER, live: true, persisted: true, bestMatch: { seq: 4 } }]
		}),
		searchEvents: async () => ({
			items: [
				{ sessionId: 's1', seq: 1, type: 'user/message', time: 1001, surface: 'current', snippet: 'build' },
				{ sessionId: 's1', seq: 4, type: 'assistant/message', time: 1004, surface: 'current', snippet: 'build' }
			]
		}),
		...overrides
	};
}

function setup(options = {}) {
	const dir = tempDir();
	const config = normalizeConfig({ root: dir, dir, ...(options.config ?? {}) });
	const env = openEnv(dir, {
		maxEntries: config.maxEntries,
		maxCatalogChars: config.maxCatalogChars
	});
	const store = env.store;
	const definitions = new Map();
	const ctx = {
		logger: {},
		get(name) {
			if (name === 'sessionQuery') return options.service ?? service();
			return undefined;
		},
		tools: {
			register(definition) {
				definitions.set(definition.name, definition);
				return () => {};
			}
		},
		on: () => () => {},
		effect(body) {
			body();
			return () => {};
		}
	};
	installTools(ctx, store, env.archive, env.registry, config);
	const tool = (name) => definitions.get(name);
	const agent = (origin) => ({
		id: 'a1',
		session: {
			id: 's1',
			header: { id: 's1', createdAt: 100, ...(origin === undefined ? {} : { origin }) },
			seq: 10,
			deriveMessages: () => []
		}
	});
	return {
		dir,
		config,
		store,
		archive: env.archive,
		registry: env.registry,
		tool,
		agent: agent(),
		subagent: agent('subagent')
	};
}

test('memory_set creates a Markdown entry; memory_get reads it back', async () => {
	const { dir, tool, agent, store } = setup();
	const set = await tool('memory_set').execute(
		{ key: 'project/build', value: '构建用 pnpm[1](s1:3)。', description: 'build command' },
		{ agent }
	);
	assert.equal(set.ok, true);
	assert.equal(set.created, true);
	assert.equal(set.revision, 1);
	const entry = store.get('project/build');
	assert.equal(entry.value, '构建用 pnpm[1](s1:3)。');
	assert.equal(entry.sourceSession, undefined);
	assert.equal(entry.sourceTurn, undefined);
	const get = await tool('memory_get').execute({ key: 'project/build' }, { agent });
	assert.equal(get.value, '构建用 pnpm[1](s1:3)。');
	assert.equal(get.description, 'build command');
	assert.equal(get.source, undefined);
	const all = await tool('memory_get').execute({}, { agent });
	assert.equal(all.keys[0].key, 'project/build');
	assert.match(all.currentSession, /^m-[0-9a-z]+$/);
	assert.equal(all.currentTurn, 3);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_set records @global and keeps Markdown values', async () => {
	const { dir, tool, agent, store } = setup();
	await tool('memory_set').execute({ key: '@global', value: 'global notes[1](s1:3)' }, { agent });
	assert.equal(store.get('@global').value, 'global notes[1](s1:3)');
	assert.equal(store.snapshot().catalog.length, 0);
	await tool('memory_set').execute({ key: 'other', value: 'other fact[2](s2:7)' }, { agent });
	assert.equal(store.get('other').value, 'other fact[2](s2:7)');
	rmSync(dir, { recursive: true, force: true });
});

test('memory_set clears description with an empty string', async () => {
	const { dir, tool, agent, store } = setup();
	await tool('memory_set').execute({ key: 'a', value: 'one', description: 'd' }, { agent });
	await tool('memory_set').execute({ key: 'a', value: 'two', description: '' }, { agent });
	const entry = store.get('a');
	assert.equal(entry.value, 'two');
	assert.equal(entry.description, undefined);
	assert.equal(entry.sourceSession, undefined);
	rmSync(dir, { recursive: true, force: true });
});


test('subagent writes are denied unless configured', async () => {
	const { dir, tool, subagent } = setup();
	await assert.rejects(
		() => tool('memory_set').execute({ key: 'a', value: 'v' }, { agent: subagent }),
		/MEMORY_SUBAGENT_WRITE_DENIED/
	);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_recall reads an explicit round and omits tool events', async () => {
	const { dir, tool, agent } = setup();
	const text = await tool('memory_recall').execute({ session_id: 's1', turn: 3 }, { agent });
	assert.match(text, /Session: Build script \(s1\)/);
	assert.match(text, /Turn 3/);
	assert.match(text, /user: build\?/);
	assert.match(text, /assistant: pnpm build/);
	assert.doesNotMatch(text, /bash/);
	assert.doesNotMatch(text, /ok/);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_recall reads the values written in a citation', async () => {
	const { dir, tool, agent } = setup();
	await tool('memory_set').execute({ key: 'preference', value: '偏好中文[1](s1:3)。' }, { agent });
	const text = await tool('memory_recall').execute({ session_id: 's1', turn: 3 }, { agent });
	assert.match(text, /Turn 3/);
	assert.match(text, /pnpm build/);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_recall supports explicit session and turn plus neighbors', async () => {
	const { dir, tool, agent } = setup();
	const text = await tool('memory_recall').execute(
		{ session_id: 's1', turn: 3, before: 1, after: 1 },
		{ agent }
	);
	assert.match(text, /Turn 3/);
	assert.match(text, /pnpm build/);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_recall defaults to the current session and latest archived round', async () => {
	const { dir, tool, agent, registry, archive } = setup();
	const registered = registry.ensure('dsh', 's1');
	archive.append({
		agent: 'dsh',
		session: registered.id,
		turn: 4,
		time: 4000,
		user: ['现在第几轮？'],
		answer: '第 4 轮。'
	});
	archive.append({
		agent: 'dsh',
		session: registered.id,
		turn: 5,
		time: 5000,
		user: ['最新一轮'],
		answer: '这是最新回答。'
	});
	const text = await tool('memory_recall').execute({}, { agent });
	assert.match(text, new RegExp('Session: .*\\(' + registered.id + '\\)'));
	assert.match(text, /Turn 5/);
	assert.match(text, /这是最新回答/);
	assert.doesNotMatch(text, /Turn 4/);
	rmSync(dir, { recursive: true, force: true });
});

test('memory_recall accepts a host-native id for an archived session', async () => {
	const { dir, tool, agent, registry, archive } = setup();
	const registered = registry.ensure('dsh', 's1');
	archive.append({
		agent: 'dsh',
		session: registered.id,
		turn: 2,
		time: 2000,
		user: ['原生日志的问题'],
		answer: '原生日志的回答'
	});
	const text = await tool('memory_recall').execute({ session_id: 's1', turn: 2 }, { agent });
	assert.match(text, /原生日志的问题/);
	assert.match(text, new RegExp(registered.id));
	rmSync(dir, { recursive: true, force: true });
});

test('session_search reads the archive first and returns unified ids', async () => {
	const { dir, tool, agent, registry, archive } = setup();
	const registered = registry.ensure('dsh', 's1');
	archive.append({
		agent: 'dsh',
		session: registered.id,
		turn: 7,
		time: 7000,
		user: ['归档里的构建问题'],
		answer: '用 pnpm build 构建'
	});
	const result = await tool('memory_search').execute({ query: 'pnpm', limit: 5 }, { agent });
	assert.equal(result.mode, 'archive');
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].sessionId, registered.id);
	assert.equal(result.hits[0].nativeId, 's1');
	assert.equal(result.hits[0].turn, 7);
	rmSync(dir, { recursive: true, force: true });
});


test('session_list and session_search are registered and return structured results', async () => {
	const { dir, tool, agent } = setup();
	const list = await tool('session_list').execute({ limit: 5 }, { agent });
	assert.equal(list.sessions.length, 1);
	assert.equal(list.sessions[0].title, 'Build script');

	const search = await tool('memory_search').execute(
		{ query: 'pnpm', max_sessions: 5, limit: 5 },
		{ agent }
	);
	assert.equal(search.mode, 'fts');
	assert.equal(search.hits.length, 1);
	assert.equal(search.hits[0].turn, 3);
	assert.equal(search.hits[0].matched, 'both');
	rmSync(dir, { recursive: true, force: true });
});

test('memory_delete removes a key', async () => {
	const { dir, tool, agent } = setup();
	await tool('memory_set').execute({ key: 'a', value: 'v' }, { agent });
	const deleted = await tool('memory_delete').execute({ key: 'a' }, { agent });
	assert.equal(deleted.deleted, true);
	const missing = await tool('memory_delete').execute({ key: 'a' }, { agent });
	assert.equal(missing.deleted, false);
	rmSync(dir, { recursive: true, force: true });
});
