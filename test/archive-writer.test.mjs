import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDir, openEnv } from './helpers.mjs';
import { installArchiveWriter, backfillSession } from '../lib/archive-writer.js';

function fakeContext(readSession) {
	const listeners = new Map();
	const ctx = {
		logger: {},
		get(name) {
			if (name === 'sessionQuery' && readSession !== undefined) return { readSession };
			return undefined;
		},
		tools: { register: () => () => {} },
		on(event, listener) {
			listeners.set(event, listener);
			return () => {};
		},
		effect(body) {
			body();
			return () => {};
		}
	};
	return { ctx, emit: (payload) => listeners.get('session/event')?.(payload) };
}

function session(id, origin) {
	return {
		id,
		header: { id, createdAt: 0, ...(origin === undefined ? {} : { origin }) },
		seq: 10,
		deriveMessages: () => []
	};
}

const config = { archive: true, archiveBackfill: true };

function events(turn, user, answer) {
	return [
		{ seq: 0, time: 1000, type: 'turn/start', data: { turn } },
		{ seq: 1, time: 1001, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } },
		{ seq: 2, time: 1002, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
		{ seq: 3, time: 1003, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } },
		{ seq: 4, time: 1004, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
	];
}

test('turn/end archives one round under the unified session id', () => {
	const dir = tempDir();
	const env = openEnv(dir);
	const { ctx, emit } = fakeContext();
	installArchiveWriter(ctx, env.archive, env.registry, config);
	const live = session('session-abc');
	for (const event of events(3, '构建怎么跑？', '用 pnpm build。')) {
		emit({ session: live, event });
	}
	const registered = env.registry.find('dsh', 'session-abc');
	assert.ok(registered !== undefined);
	const rounds = env.archive.read(registered.id);
	assert.equal(rounds.length, 1);
	assert.equal(rounds[0].turn, 3);
	assert.deepEqual(rounds[0].user, ['构建怎么跑？']);
	assert.equal(rounds[0].answer, '用 pnpm build。');
	assert.equal(rounds[0].agent, 'dsh');
	rmSync(dir, { recursive: true, force: true });
});

test('subagent sessions are never archived', () => {
	const dir = tempDir();
	const env = openEnv(dir);
	const { ctx, emit } = fakeContext();
	installArchiveWriter(ctx, env.archive, env.registry, config);
	const child = session('session-child', 'subagent');
	for (const event of events(1, '子任务', '完成')) {
		emit({ session: child, event });
	}
	assert.equal(env.registry.find('dsh', 'session-child'), undefined);
	assert.equal(env.archive.sessions().length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test('backfill reads the native log once and skips known sessions', async () => {
	const dir = tempDir();
	const env = openEnv(dir);
	const { ctx } = fakeContext(async () => ({ events: events(2, '历史问题', '历史回答') }));
	const agent = { id: 'a1', session: session('session-old') };
	const written = await backfillSession(ctx, env.archive, env.registry, config, agent);
	assert.equal(written, 1);
	const registered = env.registry.find('dsh', 'session-old');
	assert.ok(registered !== undefined);
	assert.equal(env.archive.read(registered.id)[0].answer, '历史回答');
	const again = await backfillSession(ctx, env.archive, env.registry, config, agent);
	assert.equal(again, 0);
	rmSync(dir, { recursive: true, force: true });
});
