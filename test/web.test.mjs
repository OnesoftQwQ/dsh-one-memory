import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWeb } from '../lib/web.js';
import { normalizeConfig } from '../lib/core/config.js';
import { tempDir, openEnv } from './helpers.mjs';

function setup(options = {}) {
	const dir = tempDir();
	const config = normalizeConfig({ root: dir, dir, ...(options.config ?? {}) });
	const store = openEnv(dir, { maxEntries: config.maxEntries, maxCatalogChars: config.maxCatalogChars }).store;
	let route;
	const scope = {
		get(name) {
			if (name === 'webServer') {
				return options.noServer
					? undefined
					: { register: (value) => { route = value; return () => {} } };
			}
			return undefined;
		},
		effect(body) {
			body();
			return () => {};
		}
	};
	const ctx = {
		logger: {},
		get() {
			return undefined;
		},
		tools: { register: () => () => {} },
		on: () => () => {},
		effect(body) {
			body();
			return () => {};
		},
		inject(dependencies, callback) {
			assert.deepEqual(dependencies, ['webServer']);
			callback(scope);
			return () => {};
		}
	};
	installWeb(ctx, store, config);
	return {
		dir,
		store,
		config,
		handler: () => route,
		cleanup: () => rmSync(dir, { recursive: true, force: true })
	};
}

function request(method, url, body) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return {
		method,
		url,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		}
	};
}

function response() {
	const result = { status: 0, headers: {}, body: '' };
	return {
		writeHead(status, headers) {
			result.status = status;
			result.headers = headers ?? {};
		},
		end(text) {
			result.body = text ?? '';
		},
		result
	};
}

async function call(app, method, path, body) {
	const res = response();
	await app.handler().handler(request(method, '/one-memory' + path, body), res);
	return { status: res.result.status, body: JSON.parse(res.result.body) };
}

test('web API returns the current state including the global memory', async () => {
	const app = setup();
	app.store.set('@global', { value: 'global note' });
	app.store.set('project/build', { value: 'pnpm build', description: 'build' });
	const state = await call(app, 'GET', '/state');
	assert.equal(state.status, 200);
	assert.equal(state.body.revision, 2);
	assert.equal(state.body.global.value, 'global note');
	assert.deepEqual(
		state.body.entries.map((entry) => entry.key),
		['project/build']
	);
	assert.equal(state.body.entries[0].description, 'build');
	assert.equal(state.body.maxEntries, 500);
	app.cleanup();
});

test('web API saves and deletes memory entries', async () => {
	const app = setup();
	const saved = await call(app, 'POST', '/save', {
		key: 'user/preferences',
		value: 'prefers Chinese[1](session-a:3)',
		description: 'language'
	});
	assert.equal(saved.status, 200);
	assert.equal(saved.body.entries[0].key, 'user/preferences');
	assert.equal(app.store.get('user/preferences').description, 'language');

	const deleted = await call(app, 'POST', '/delete', { key: 'user/preferences' });
	assert.equal(deleted.status, 200);
	assert.equal(deleted.body.entries.length, 0);
	assert.equal(app.store.get('user/preferences'), undefined);
	app.cleanup();
});

test('web API rejects invalid keys, empty values, and oversized values', async () => {
	const app = setup({ config: { maxEntryChars: 10 } });
	const badKey = await call(app, 'POST', '/save', { key: 'bad key!', value: 'x' });
	assert.equal(badKey.status, 400);

	const empty = await call(app, 'POST', '/save', { key: 'ok', value: '   ' });
	assert.equal(empty.status, 400);

	// maxEntryChars is clamped to at least 64 by the configuration bounds.
	const long = await call(app, 'POST', '/save', { key: 'ok', value: 'x'.repeat(100) });
	assert.equal(long.status, 400);
	app.cleanup();
});

test('web API reports a full memory as a conflict', async () => {
	const app = setup({ config: { maxEntries: 1 } });
	await call(app, 'POST', '/save', { key: 'a', value: 'one' });
	const second = await call(app, 'POST', '/save', { key: 'b', value: 'two' });
	assert.equal(second.status, 409);
	app.cleanup();
});

test('web API is not installed without a web server', () => {
	const app = setup({ noServer: true });
	assert.equal(app.handler(), undefined);
	app.cleanup();
});
