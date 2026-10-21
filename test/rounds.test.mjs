import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildRounds,
	selectRounds,
	searchRounds,
	roundForSeq,
	RoundNotFoundError
} from '../lib/core/rounds.js';

function text(t) {
	return [{ type: 'text', text: t }];
}

function fixture() {
	return [
		{ seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
		{
			seq: 1,
			time: 1001,
			type: 'user/message',
			data: { source: { kind: 'user' }, content: text('build?') }
		},
		{
			seq: 2,
			time: 1002,
			type: 'assistant/message',
			data: {
				message: {
					content: [
						{ type: 'text', text: 'Let me check.' },
						{ type: 'tool-call', name: 'bash', arguments: '{}' }
					]
				}
			}
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
			data: {
				message: {
					content: [
						{ type: 'reasoning', text: 'internal' },
						{ type: 'text', text: 'Use pnpm build.' }
					]
				}
			}
		},
		{ seq: 6, time: 1006, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
		{ seq: 7, time: 2000, type: 'turn/start', data: { turn: 2 } },
		{
			seq: 8,
			time: 2001,
			type: 'user/message',
			data: { source: { kind: 'user' }, content: text('ci?') }
		},
		{
			seq: 9,
			time: 2002,
			type: 'user/message',
			data: { source: { kind: 'agent-memory' }, content: text('injected context') }
		},
		{
			seq: 10,
			time: 2003,
			type: 'assistant/message',
			data: { message: { content: text('Update CI.') } }
		}
	];
}

test('projects a round to direct user text plus the final answer', () => {
	const rounds = buildRounds(fixture());
	assert.equal(rounds.length, 2);
	const first = rounds[0];
	assert.equal(first.turn, 1);
	assert.deepEqual(first.users, ['build?']);
	assert.deepEqual(first.userSeqs, [1]);
	assert.equal(first.answer, 'Use pnpm build.');
	assert.equal(first.answerSeq, 5);
	assert.equal(first.inProgress, false);
	assert.equal(first.endReason, 'completed');

	const second = rounds[1];
	assert.equal(second.turn, 2);
	assert.deepEqual(second.users, ['ci?']);
	assert.equal(second.answer, 'Update CI.');
	assert.equal(second.inProgress, true);
});

test('falls back to the last assistant text when a turn ends after a tool call', () => {
	const events = [
		{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
		{ seq: 1, time: 2, type: 'user/message', data: { source: { kind: 'user' }, content: text('go') } },
		{ seq: 2, time: 3, type: 'assistant/message', data: { message: { content: text('checking') } } },
		{ seq: 3, time: 4, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
		{ seq: 4, time: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }
	];
	const rounds = buildRounds(events);
	assert.equal(rounds[0].answer, 'checking');
	assert.equal(rounds[0].endReason, 'aborted');
});

test('roundForSeq and selectRounds select the containing turn and neighbors', () => {
	const rounds = buildRounds(fixture());
	assert.equal(roundForSeq(rounds, 3)?.turn, 1);
	assert.equal(roundForSeq(rounds, 8)?.turn, 2);
	assert.equal(roundForSeq(rounds, 99), undefined);
	assert.deepEqual(selectRounds(rounds, 2, 1, 0).map((round) => round.turn), [1, 2]);
	assert.deepEqual(selectRounds(rounds, 1, 0, 1).map((round) => round.turn), [1, 2]);
	assert.throws(() => selectRounds(rounds, 3, 0, 0), RoundNotFoundError);
});

test('searchRounds matches user and final-answer text only', () => {
	const rounds = buildRounds(fixture());
	const pnpm = searchRounds(rounds, 'pnpm');
	assert.equal(pnpm.length, 1);
	assert.equal(pnpm[0].round.turn, 1);
	assert.equal(pnpm[0].matched, 'assistant');

	const ci = searchRounds(rounds, 'ci');
	assert.equal(ci.length, 1);
	assert.equal(ci[0].round.turn, 2);
	assert.equal(ci[0].matched, 'both');

	// Intermediate assistant text and tool output are not part of a round.
	assert.equal(searchRounds(rounds, 'let me check').length, 0);
	assert.equal(searchRounds(rounds, 'ok').length, 0);
	assert.equal(searchRounds(rounds, 'internal').length, 0);
	assert.equal(searchRounds(rounds, 'injected').length, 0);
});

test('Chinese text is matched literally', () => {
	const events = [
		{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } },
		{
			seq: 1,
			time: 2,
			type: 'user/message',
			data: { source: { kind: 'user' }, content: text('以后构建都用 pnpm') }
		},
		{
			seq: 2,
			time: 3,
			type: 'assistant/message',
			data: { message: { content: text('好的，构建都用 pnpm。') } }
		},
		{ seq: 3, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
	];
	const rounds = buildRounds(events);
	const matches = searchRounds(rounds, '构建');
	assert.equal(matches.length, 1);
	assert.equal(matches[0].matched, 'both');
});
