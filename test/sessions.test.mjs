import test from 'node:test';
import assert from 'node:assert/strict';
import { listSessions, searchSessions } from '../lib/core/sessions.js';

const HEADERS = {
	s1: { id: 's1', createdAt: 100, cwd: '/repo/a' },
	s2: { id: 's2', createdAt: 200, origin: 'subagent', parentSession: 's1' },
	s3: { id: 's3', createdAt: 300, cwd: '/repo/b' }
};

const RECORDS = [
	{ header: HEADERS.s3, live: false, persisted: true },
	{ header: HEADERS.s2, live: false, persisted: true },
	{ header: HEADERS.s1, live: true, persisted: true }
];

const TITLES = { s1: 'Build script', s3: 'Deploy notes' };

function fakeCtx() {
	return {
		logger: {},
		get(name) {
			if (name === 'sessionProjectionCache') {
				return {
					cachedSnapshot(header) {
						const title = TITLES[header.id];
						return title === undefined ? undefined : { values: { title } };
					}
				};
			}
			return undefined;
		}
	};
}

function text(value) {
	return [{ type: 'text', text: value }];
}

function events() {
	return [
		{ seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
		{
			seq: 1,
			time: 1001,
			type: 'user/message',
			data: { source: { kind: 'user' }, content: text('how do we build?') }
		},
		{
			seq: 2,
			time: 1002,
			type: 'assistant/message',
			data: { message: { content: text('looking at the build') } }
		},
		{ seq: 3, time: 1003, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
		{
			seq: 4,
			time: 1004,
			type: 'tool/result',
			data: { message: { content: text('ok') } }
		},
		{
			seq: 5,
			time: 1005,
			type: 'assistant/message',
			data: { message: { content: text('Use pnpm build.') } }
		},
		{ seq: 6, time: 1006, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
	];
}

function baseService(overrides = {}) {
	return {
		listSessions: async () => RECORDS,
		readSession: async (id) => ({
			session: HEADERS[id] ?? HEADERS.s1,
			events: id === 's1' ? events() : []
		}),
		readTitle: async (id) => {
			const title = TITLES[id];
			return title === undefined ? undefined : { title, eventSeq: 0, updatedAt: 0 };
		},
		readTitleSnapshots: async (ids) =>
			ids.map((id) => ({
				sessionId: id,
				status: TITLES[id] === undefined ? 'rejected' : 'fulfilled',
				value: TITLES[id] === undefined ? undefined : { title: { title: TITLES[id] } }
			})),
		searchSessions: async () => {
			throw Object.assign(new Error('search disabled'), {
				code: 'SESSION_QUERY_SEARCH_DISABLED'
			});
		},
		searchEvents: async () => {
			throw Object.assign(new Error('search disabled'), {
				code: 'SESSION_QUERY_SEARCH_DISABLED'
			});
		},
		...overrides
	};
}

test('session_list filters, pages, and uses cached titles', async () => {
	const result = await listSessions(fakeCtx(), baseService(), { limit: 10 });
	assert.equal(result.total, 2);
	assert.equal(result.matched, 2);
	assert.deepEqual(result.sessions.map((row) => row.id), ['s3', 's1']);
	assert.equal(result.sessions[0].title, 'Deploy notes');
	assert.equal(result.sessions[1].title, 'Build script');

	const filtered = await listSessions(fakeCtx(), baseService(), { query: 'build', limit: 10 });
	assert.deepEqual(filtered.sessions.map((row) => row.id), ['s1']);

	const subagents = await listSessions(fakeCtx(), baseService(), {
		includeSubagents: true,
		limit: 10
	});
	assert.deepEqual(subagents.sessions.map((row) => row.id), ['s3', 's2', 's1']);

	const page = await listSessions(fakeCtx(), baseService(), { offset: 1, limit: 1 });
	assert.deepEqual(page.sessions.map((row) => row.id), ['s1']);
	assert.equal(page.truncated, false);
});

test('session_search uses FTS hits, dedupes a round, and ignores intermediate text', async () => {
	const service = baseService({
		searchSessions: async () => ({
			items: [{ header: HEADERS.s1, live: true, persisted: true, bestMatch: { seq: 5 } }]
		}),
		searchEvents: async () => ({
			items: [
				{ sessionId: 's1', seq: 1, type: 'user/message', time: 1001, surface: 'current', snippet: 'build' },
				{ sessionId: 's1', seq: 2, type: 'assistant/message', time: 1002, surface: 'current', snippet: 'build' },
				{ sessionId: 's1', seq: 5, type: 'assistant/message', time: 1005, surface: 'current', snippet: 'build' }
			]
		})
	});
	const result = await searchSessions(fakeCtx(), service, {
		query: 'build',
		maxSessions: 10,
		limit: 5
	});
	assert.equal(result.mode, 'fts');
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].sessionId, 's1');
	assert.equal(result.hits[0].title, 'Build script');
	assert.equal(result.hits[0].turn, 1);
	assert.equal(result.hits[0].matched, 'both');
	assert.match(result.hits[0].user, /build/);
	assert.match(result.hits[0].assistant, /pnpm build/);
});

test('session_search falls back to a literal scan when FTS is disabled', async () => {
	const result = await searchSessions(fakeCtx(), baseService(), {
		query: 'pnpm',
		maxSessions: 10,
		limit: 5
	});
	assert.equal(result.mode, 'literal');
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].turn, 1);
	assert.equal(result.hits[0].matched, 'assistant');
});

test('session_search with session_id falls back when FTS is disabled', async () => {
	const service = baseService({
		searchEvents: async () => {
			throw Object.assign(new Error('search disabled'), {
				code: 'SESSION_QUERY_SEARCH_DISABLED'
			});
		}
	});
	const result = await searchSessions(fakeCtx(), service, {
		query: 'pnpm',
		sessionId: 's1',
		maxSessions: 10,
		limit: 5
	});
	assert.equal(result.mode, 'literal');
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].turn, 1);
	assert.equal(result.hits[0].matched, 'assistant');
});

test('session_search with session_id searches only that session', async () => {
	let listCalls = 0;
	const service = baseService({
		searchSessions: async () => {
			throw new Error('must not discover candidates for an explicit session');
		},
		searchEvents: async (request) => {
			assert.equal(request.sessionId, 's1');
			return {
				items: [
					{ sessionId: 's1', seq: 5, type: 'assistant/message', time: 1005, surface: 'current', snippet: 'pnpm' }
				]
			};
		}
	});
	const result = await searchSessions(fakeCtx(), service, {
		query: 'pnpm',
		sessionId: 's1',
		maxSessions: 10,
		limit: 5
	});
	assert.equal(result.mode, 'fts');
	assert.equal(result.hits.length, 1);
	assert.equal(result.hits[0].turn, 1);
	assert.equal(result.hits[0].matched, 'assistant');
});
