import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDir, openEnv } from './helpers.mjs';

function round(overrides = {}) {
	return {
		agent: 'dsh',
		session: 'm-abc123',
		turn: 1,
		time: 1000,
		user: ['你好'],
		answer: '你好，有什么可以帮你？',
		...overrides
	};
}

test('archive appends and reads rounds in turn order', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	archive.append(round());
	archive.append(round({ turn: 2, time: 2000, user: ['构建怎么跑'], answer: '用 pnpm build' }));
	assert.equal(archive.has('m-abc123'), true);
	assert.equal(archive.has('m-missing'), false);
	const rounds = archive.read('m-abc123');
	assert.deepEqual(rounds.map((entry) => entry.turn), [1, 2]);
	assert.deepEqual(rounds[1].user, ['构建怎么跑']);
	assert.equal(archive.lastTurn('m-abc123'), 2);
	rmSync(dir, { recursive: true, force: true });
});

test('appending the same turn replaces instead of duplicating', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	archive.append(round());
	archive.append(round({ answer: '更新后的回答' }));
	const rounds = archive.read('m-abc123');
	assert.equal(rounds.length, 1);
	assert.equal(rounds[0].answer, '更新后的回答');
	rmSync(dir, { recursive: true, force: true });
});

test('slice returns the round with neighbors', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	for (let turn = 1; turn <= 5; turn += 1) {
		archive.append(round({ turn, time: turn * 1000, user: [`问题${turn}`], answer: `回答${turn}` }));
	}
	const sliced = archive.slice('m-abc123', 3, 1, 1);
	assert.equal(sliced.found, true);
	assert.deepEqual(sliced.rounds.map((entry) => entry.turn), [2, 3, 4]);
	const missing = archive.slice('m-abc123', 99, 0, 0);
	assert.equal(missing.found, false);
	assert.deepEqual(missing.turns, [1, 2, 3, 4, 5]);
	rmSync(dir, { recursive: true, force: true });
});

test('search matches user and final-answer text only', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	archive.append(round({ session: 'm-one', turn: 1, user: ['用 pnpm 构建'], answer: '好的，用 pnpm。' }));
	archive.append(round({ session: 'm-two', turn: 1, user: ['其他问题'], answer: '无关回答' }));
	const hits = archive.search('pnpm');
	assert.equal(hits.length, 1);
	assert.equal(hits[0].round.session, 'm-one');
	assert.equal(hits[0].matched, 'both');
	assert.equal(archive.search('不存在的词').length, 0);
	rmSync(dir, { recursive: true, force: true });
});

test('search escapes LIKE wildcards', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	archive.append(round({ user: ['100% 完成'], answer: '好的' }));
	assert.equal(archive.search('100%').length, 1);
	assert.equal(archive.search('%').length, 1);
	rmSync(dir, { recursive: true, force: true });
});

test('sessions lists archived sessions newest first', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir);
	archive.append(round({ session: 'm-old', turn: 1, time: 1000 }));
	archive.append(round({ session: 'm-new', turn: 1, time: 5000 }));
	const sessions = archive.sessions();
	assert.deepEqual(sessions.map((entry) => entry.session), ['m-new', 'm-old']);
	assert.equal(sessions[0].rounds, 1);
	rmSync(dir, { recursive: true, force: true });
});

test('retention keeps only the newest rounds per session', () => {
	const dir = tempDir();
	const { archive } = openEnv(dir, { maxRoundsPerSession: 10 });
	for (let turn = 1; turn <= 15; turn += 1) {
		archive.append(round({ turn, time: turn }));
	}
	const rounds = archive.read('m-abc123');
	assert.equal(rounds.length, 10);
	assert.equal(rounds[0].turn, 6);
	rmSync(dir, { recursive: true, force: true });
});
