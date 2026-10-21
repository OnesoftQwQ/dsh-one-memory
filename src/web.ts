/**
 * Same-origin HTTP API for the memory management page.
 *
 * The page is a browser plugin and cannot reach the Host store directly, so
 * the Host half registers three routes on `ctx.webServer`:
 *
 *   GET  /one-memory/state   -> { revision, path, maxEntries, global, entries }
 *   POST /one-memory/save    -> { key, value, description? }
 *   POST /one-memory/delete  -> { key }
 *
 * The routes share the plugin's store instance, so a save from the page bumps
 * the same revision the model's tools use and therefore reaches every live
 * session through the incremental injection path.
 *
 * @module one-memory/web
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginContext } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import { GLOBAL_KEY, MemoryLimitError, type MemoryStore } from './core/store.js';

const ROUTE_PREFIX = '/one-memory';
const KEY_PATTERN = /^[@\p{L}\p{N}._:/-]{1,80}$/u;
const MAX_DESCRIPTION = 160;

type WebServerLike = {
	register(route: {
		kind: 'prefix' | 'exact';
		path: string;
		handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
	}): () => void;
};

interface SaveBody {
	key?: unknown;
	value?: unknown;
	description?: unknown;
}

interface DeleteBody {
	key?: unknown;
}

/**
 * Install the management routes when the deployment serves HTTP.
 * @param ctx - plugin context.
 * @param store - the shared memory store.
 * @param config - resolved plugin configuration.
 */
export function installWeb(ctx: PluginContext, store: MemoryStore, config: MemoryConfig): void {
	if (typeof ctx.inject !== 'function') return;
	ctx.effect(() =>
		ctx.inject!(['webServer'], (scope) => {
			const webServer = scope.get('webServer') as WebServerLike | undefined;
			if (webServer === undefined) return;
			scope.effect(() =>
				webServer.register({
					kind: 'prefix',
					path: ROUTE_PREFIX,
					handler: async (req, res) => {
						const path = (req.url ?? '').split('?')[0] ?? '';
						try {
							if (path === `${ROUTE_PREFIX}/state` && (req.method === 'GET' || req.method === 'HEAD')) {
								sendJson(res, 200, statePayload(store, config));
								return;
							}
							if (path === `${ROUTE_PREFIX}/save` && req.method === 'POST') {
								const body = await readJson<SaveBody>(req);
								const key = requiredKey(body.key);
								const value = typeof body.value === 'string' ? body.value : '';
								if (value.trim() === '') throw new HttpError(400, 'value must be non-empty');
								const limit = key === GLOBAL_KEY ? config.maxGlobalChars : config.maxEntryChars;
								if (value.length > limit) {
									throw new HttpError(400, `value is ${value.length} chars; the limit is ${limit}`);
								}
								const description = descriptionOf(body.description, key);
								try {
									store.set(key, { value, description });
								} catch (error) {
									if (error instanceof MemoryLimitError) throw new HttpError(409, error.message);
									throw error;
								}
								sendJson(res, 200, statePayload(store, config));
								return;
							}
							if (path === `${ROUTE_PREFIX}/delete` && req.method === 'POST') {
								const body = await readJson<DeleteBody>(req);
								const key = requiredKey(body.key);
								store.delete(key);
								sendJson(res, 200, statePayload(store, config));
								return;
							}
							sendJson(res, 404, { error: 'not found' });
						} catch (error) {
							const status = error instanceof HttpError ? error.status : 500;
							sendJson(res, status, {
								error: error instanceof Error ? error.message : String(error)
							});
						}
					}
				})
			);
		})
	);
}

function statePayload(store: MemoryStore, config: MemoryConfig): Record<string, unknown> {
	const snapshot = store.snapshot();
	const entries = store.entries();
	const globalEntry = entries.find((entry) => entry.key === GLOBAL_KEY);
	return {
		revision: snapshot.revision,
		path: store.path,
		maxEntries: config.maxEntries,
		maxGlobalChars: config.maxGlobalChars,
		maxEntryChars: config.maxEntryChars,
		global:
			globalEntry === undefined
				? null
				: {
						value: globalEntry.value,
						revision: globalEntry.revision ?? null,
						updatedAt: new Date(globalEntry.updatedAt).toISOString()
					},
		entries: entries
			.filter((entry) => entry.key !== GLOBAL_KEY)
			.map((entry) => ({
				key: entry.key,
				value: entry.value,
				description: entry.description ?? null,
				revision: entry.revision ?? null,
				updatedAt: new Date(entry.updatedAt).toISOString()
			}))
	};
}

function requiredKey(value: unknown): string {
	if (typeof value !== 'string') throw new HttpError(400, 'key must be a string');
	const key = value.trim();
	if (!KEY_PATTERN.test(key)) throw new HttpError(400, 'invalid key');
	return key;
}

function descriptionOf(value: unknown, key: string): string | null | undefined {
	if (key === GLOBAL_KEY) return undefined;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new HttpError(400, 'description must be a string');
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length > MAX_DESCRIPTION) {
		throw new HttpError(400, `description is ${trimmed.length} chars; the limit is ${MAX_DESCRIPTION}`);
	}
	return trimmed;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
	let body = '';
	for await (const chunk of req) body += chunk;
	if (body === '') return {} as T;
	try {
		return JSON.parse(body) as T;
	} catch {
		throw new HttpError(400, 'invalid JSON body');
	}
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	const text = JSON.stringify(payload);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store'
	});
	res.end(text);
}

class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}
