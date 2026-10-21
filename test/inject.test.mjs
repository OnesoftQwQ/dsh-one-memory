import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installInjection } from '../lib/inject.js';
import { tempDir, openEnv } from './helpers.mjs';

function fakeContext() {
	let handler;
	const ctx = {
		logger: {},
		get() {
			return undefined;
		},
		tools: { register: () => () => {} },
		on(event, listener) {
			if (event === 'agent/pre-step') handler = listener;
			return () => {};
		},
		effect(body) {
			body();
			return () => {};
		}
	};
	return { ctx, handler: () => handler };
}

function userMessage(text = 'hello') {
	return {
		id: 'u1',
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'user' }
	};
}

function memoryMessage(revision, memoryKind = 'baseline') {
	return {
		id: 'm1',
		role: 'user',
		content: [{ type: 'text', text: 'memory' }],
		source: {
			kind: 'agent-memory',
			form: 'snapshot',
			memoryKind,
			revision
		}
	};
}

function agentWith(deriveMessages, origin) {
	return {
		id: 'a1',
		session: {
			id: 'session-1',
			header: { id: 'session-1', createdAt: 0, ...(origin === undefined ? {} : { origin }) },
			seq: 1,
			deriveMessages
		}
	};
}

function setup(options = {}) {
	const dir = tempDir();
	const env = openEnv(dir, { maxEntries: 20, maxCatalogChars: 1000 });
	const context = fakeContext();
	installInjection(context.ctx, env.store, env.registry, {
		injectGlobal: true,
		injectGlobalInSubagents: options.injectSubagents === true
	});
	const registered = env.registry.ensure('dsh', 'session-1');
	return {
		dir,
		store: env.store,
		sessionId: registered.id,
		handler: context.handler,
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

async function run(handler, agent, options = {}) {
	const decision = {
		kind: 'enter',
		messages: options.messages ?? [userMessage()]
	};
	const result = await handler()(
		{ agent, messages: decision.messages, step: options.step ?? 1, turn: options.turn ?? 7 },
		async () => decision
	);
	return result;
}

test('injects a full baseline when no memory block is visible', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global one' });
	app.store.set('a', { value: 'a-one', description: 'first' });
	const agent = agentWith(() => [userMessage()]);
	const result = await run(app.handler, agent);
	assert.equal(result.kind, 'enter');
	assert.equal(result.messages.length, 2);
	const injected = result.messages[1];
	assert.equal(injected.source.kind, 'agent-memory');
	assert.equal(injected.source.memoryKind, 'baseline');
	assert.equal(injected.source.revision, app.store.revision());
	assert.equal(injected.source.turn, 7);
	assert.match(injected.content[0].text, /<global-memory>\nglobal one/);
	assert.match(injected.content[0].text, /<memory-keys>/);
	assert.match(injected.content[0].text, new RegExp('Current session: ' + app.sessionId));
	assert.match(injected.content[0].text, /Current turn: 7/);
	app.cleanup();
});

test('injects only a context line when the visible baseline is current', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global one' });
	const agent = agentWith(() => [memoryMessage(app.store.revision())]);
	const result = await run(app.handler, agent);
	assert.equal(result.messages.length, 2);
	const injected = result.messages[1];
	assert.equal(injected.source.memoryKind, 'context');
	assert.equal(injected.source.form, 'notice');
	assert.equal(injected.source.revision, app.store.revision());
	assert.match(injected.content[0].text, new RegExp('Current session: ' + app.sessionId));
	assert.match(injected.content[0].text, /Current turn: 7/);
	app.cleanup();
});

test('injects only a delta for a newer store revision', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global one' });
	app.store.set('a', { value: 'a-one', description: 'first' });
	app.store.set('b', { value: 'b-one' });
	const baselineRevision = app.store.revision();
	app.store.set('@global', { value: 'global two' });
	app.store.set('a', { value: 'a-two', description: 'first' });
	app.store.set('c', { value: 'c-one' });
	app.store.delete('b');
	const currentRevision = app.store.revision();
	const agent = agentWith(() => [memoryMessage(baselineRevision)]);
	const result = await run(app.handler, agent);
	assert.equal(result.messages.length, 2);
	const injected = result.messages[1];
	assert.equal(injected.source.memoryKind, 'delta');
	assert.equal(injected.source.fromRevision, baselineRevision);
	assert.equal(injected.source.revision, currentRevision);
	const text = injected.content[0].text;
	assert.match(text, /replaces the earlier global memory/);
	assert.match(text, /global two/);
	assert.match(text, /~ a/);
	assert.match(text, /a-two/);
	assert.match(text, /\+ c/);
	assert.match(text, /c-one/);
	assert.match(text, /- b/);
	assert.match(text, new RegExp('Current session: ' + app.sessionId));
	assert.match(text, /Current turn: 7/);
	assert.doesNotMatch(text, /global one/);
	app.cleanup();
});

test('a delta is shared across sessions via the store revision', async () => {
	const app = setup();
	app.store.set('a', { value: 'one' });
	const baselineRevision = app.store.revision();
	const sessionA = agentWith(() => [memoryMessage(baselineRevision)]);
	const sessionB = agentWith(() => [memoryMessage(baselineRevision)]);
	app.store.set('a', { value: 'two' });
	const resultB = await run(app.handler, sessionB);
	assert.equal(resultB.messages.length, 2);
	assert.equal(resultB.messages[1].source.memoryKind, 'delta');
	assert.match(resultB.messages[1].content[0].text, /~ a/);
	assert.match(resultB.messages[1].content[0].text, /two/);
	app.cleanup();
});

test('injects a full baseline when only a delta is visible', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global one' });
	app.store.set('a', { value: 'a-one' });
	const agent = agentWith(() => [memoryMessage(app.store.revision(), 'delta')]);
	const result = await run(app.handler, agent);
	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].source.memoryKind, 'baseline');
	assert.match(result.messages[1].content[0].text, /<memory-keys>/);
	assert.match(result.messages[1].content[0].text, /Current turn: 7/);
	app.cleanup();
});

test('does not inject on a non-initial step', async () => {
	const app = setup();
	app.store.set('a', { value: 'one' });
	const baselineRevision = app.store.revision();
	app.store.set('a', { value: 'two' });
	const agent = agentWith(() => [memoryMessage(baselineRevision)]);
	const result = await run(app.handler, agent, { step: 2 });
	assert.equal(result.messages.length, 1);
	app.cleanup();
});

test('subagent sessions are skipped unless configured', async () => {
	const first = setup();
	first.store.set('@global', { value: 'global' });
	const subagent = agentWith(() => [userMessage()], 'subagent');
	const skipped = await run(first.handler, subagent);
	assert.equal(skipped.messages.length, 1);
	first.cleanup();

	const second = setup({ injectSubagents: true });
	second.store.set('@global', { value: 'global' });
	const injected = await run(second.handler, subagent);
	assert.equal(injected.messages.length, 2);
	second.cleanup();
});

test('a memory clear is delivered as a global removal', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global one' });
	const baselineRevision = app.store.revision();
	app.store.delete('@global');
	const agent = agentWith(() => [memoryMessage(baselineRevision)]);
	const result = await run(app.handler, agent);
	assert.equal(result.messages.length, 2);
	assert.equal(result.messages[1].source.memoryKind, 'delta');
	assert.match(result.messages[1].content[0].text, /\(cleared\)/);
	assert.match(result.messages[1].content[0].text, /Current turn: 7/);
	app.cleanup();
});

test('injects the current turn even when memory is empty', async () => {
	const app = setup();
	const agent = agentWith(() => []);
	const result = await run(app.handler, agent);
	assert.equal(result.messages.length, 2);
	const injected = result.messages[1];
	assert.equal(injected.source.memoryKind, 'context');
	assert.match(injected.content[0].text, new RegExp('Current session: ' + app.sessionId));
	assert.match(injected.content[0].text, /Current turn: 7/);
	app.cleanup();
});

test('reject decisions and empty batches are left untouched', async () => {
	const app = setup();
	const agent = agentWith(() => []);
	const rejected = { kind: 'reject' };
	assert.deepEqual(
		await app.handler()({ agent, messages: [userMessage()], step: 1 }, async () => rejected),
		rejected
	);
	const empty = { kind: 'enter', messages: [] };
	assert.deepEqual(
		await app.handler()({ agent, messages: [], step: 1 }, async () => empty),
		empty
	);
	app.cleanup();
});