/**
 * Model-facing memory, recall, and session tools.
 *
 * @module one-memory/tools
 */

import type {
	AgentLike,
	ContentBlock,
	PluginContext,
	SessionQueryLike,
	SessionRecordLike,
	ToolDefinitionLike,
	ToolRunContextLike
} from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import { GLOBAL_KEY, MemoryLimitError, type MemoryEntry, type MemoryStore } from './core/store.js';
import { formatRecall } from './core/format.js';
import { RoundNotFoundError, loadRounds, selectRounds, type Round } from './core/rounds.js';
import { listSessions, resolveTitles, searchSessions } from './core/sessions.js';
import type { Archive, ArchivedRound } from './core/archive.js';
import type { SessionRegistry } from './core/sessions-registry.js';

/** A model-facing tool failure with a stable code in the message. */
export class MemoryToolError extends Error {
	readonly code: string;

	constructor(message: string, code: string) {
		super(`${code}: ${message}`);
		this.name = 'MemoryToolError';
		this.code = code;
	}
}

interface TurnCacheEntry {
	logLength: number;
	turn: number | null;
}

const KEY_PATTERN = /^[@\p{L}\p{N}._:/-]{1,80}$/u;
const MAX_DESCRIPTION = 160;

/** Install all model-facing tools. */
export function installTools(
	ctx: PluginContext,
	store: MemoryStore,
	archive: Archive,
	registry: SessionRegistry,
	config: MemoryConfig
): void {
	const turnCache = new Map<string, TurnCacheEntry>();
	const register = (definition: ToolDefinitionLike): void => {
		ctx.effect(() => ctx.tools.register(definition));
	};

	register({
		name: 'memory_get',
		description:
			'Read one memory entry by key, or the global memory, the full key catalog, and the current session/turn when key is omitted. Each entry carries its stored value, description, and source (session id, turn, optional conversation excerpt).',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				key: {
					type: 'string',
					description: 'Exact memory key. Omit to read the global memory and the key catalog.'
				}
			}
		},
		output: { schema: { type: 'object' }, render: renderJson },
		execute: async (rawArgs, exec) => {
			const args = objectArgs(rawArgs);
			const key = optionalString(args, 'key');
			if (key === undefined || key === '') {
				const snapshot = store.snapshot();
				return {
					revision: snapshot.revision,
					global:
						snapshot.global === undefined
							? null
							: {
									value: snapshot.global.value,
																		updatedAt: isoTime(snapshot.global.updatedAt)
								},
					keys: snapshot.catalog,
					currentSession: currentSessionId(registry, exec.agent),
					currentTurn: await currentTurn(ctx, exec.agent, turnCache)
				};
			}
			const normalized = validateKey(key);
			const entry = store.get(normalized);
			if (entry === undefined) {
				throw new MemoryToolError(`no memory with key "${normalized}"`, 'MEMORY_NOT_FOUND');
			}
			return entryView(normalized, entry);
		}
	});

	register({
		name: 'memory_set',
		description:
			'Create or update a memory entry. Use key @global for the global memory. Write value as Markdown and cite each source inline as [ref](sessionId:turn), for example "用户偏好中文回复[1](session-abc:12)"; use the Current session / Current turn values. No separate source fields are needed.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				key: {
					type: 'string',
					description: 'Stable key (1-80 letters, digits, or ._:/-); @global is reserved for the global memory.'
				},
				value: {
					type: 'string',
					description: 'Markdown memory text. Cite sources inline as [ref](sessionId:turn); keep ordinary entries bounded.'
				},
				description: {
					type: 'string',
					description: 'One-line summary shown in the session-start key catalog (max 160 chars).'
				}
			},
			required: ['key', 'value']
		},
		output: { schema: { type: 'object' }, render: renderJson },
		execute: async (rawArgs, exec) => {
			assertWritable(exec, config);
			const args = objectArgs(rawArgs);
			const key = validateKey(requiredString(args, 'key'));
			const value = requiredText(args, 'value');
			const maxChars = key === GLOBAL_KEY ? config.maxGlobalChars : config.maxEntryChars;
			if (value.length > maxChars) {
				throw new MemoryToolError(
					'value is ' + value.length + ' chars; the limit for ' + key + ' is ' + maxChars,
					'MEMORY_VALUE_TOO_LONG'
				);
			}
			const descriptionInput = key === GLOBAL_KEY ? undefined : descriptionInputOf(args);
			const currentSession = exec.agent?.session.id ?? null;
			try {
				const result = store.set(key, {
					value,
					description: descriptionInput,
					sourceSession: null,
					sourceTurn: null,
					sourceConversation: null
				});
				return {
					ok: true,
					key,
					created: result.created,
					revision: result.revision,
					currentSession
				};
			} catch (error) {
				if (error instanceof MemoryLimitError) {
					throw new MemoryToolError(error.message, 'MEMORY_LIMIT');
				}
				throw error;
			}
		}
	});
	register({
		name: 'memory_delete',
		description:
			'Delete one memory entry by key. Deleting @global clears the global memory.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				key: { type: 'string', description: 'Exact memory key to delete.' }
			},
			required: ['key']
		},
		output: { schema: { type: 'object' }, render: renderJson },
		execute: async (rawArgs, exec) => {
			assertWritable(exec, config);
			const args = objectArgs(rawArgs);
			const key = validateKey(requiredString(args, 'key'));
			return { ok: true, key, deleted: store.delete(key) };
		}
	});

	register({
		name: 'memory_recall',
		description:
			'Read a conversation round from the archive. Omit session_id to read the current session; omit turn to read the latest archived round. Use the id and turn written in a memory value as [ref](sessionId:turn) — both the unified id (m-...) and a host-native id are accepted. before/after include adjacent rounds (0-5 each). A round is one user message plus the final assistant answer; tool calls and reasoning are omitted.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				session_id: {
					type: 'string',
					description: 'Unified (m-...) or host-native session id. Defaults to the current session.'
				},
				turn: {
					type: 'integer',
					minimum: 1,
					description: '1-based turn number. Defaults to the latest archived round of that session.'
				},
				before: {
					type: 'integer',
					minimum: 0,
					maximum: 5,
					description: 'Number of preceding rounds to include; default 0.'
				},
				after: {
					type: 'integer',
					minimum: 0,
					maximum: 5,
					description: 'Number of following rounds to include; default 0.'
				}
			}
		},
		output: { schema: { type: 'string' }, render: renderText },
		execute: async (rawArgs, exec) => {
			const args = objectArgs(rawArgs);
			const requested = optionalString(args, 'session_id');
			const before = clamp(optionalInteger(args, 'before') ?? 0, 0, 5);
			const after = clamp(optionalInteger(args, 'after') ?? 0, 0, 5);
			const requestedTurn = optionalInteger(args, 'turn');
			if (requestedTurn !== undefined && requestedTurn < 1) {
				throw new MemoryToolError('turn must be >= 1', 'MEMORY_INVALID_ARGUMENTS');
			}
			let unified: string | undefined;
			let nativeId: string | undefined;
			if (requested !== undefined && requested !== '') {
				const resolved = registry.resolve(requested);
				unified = resolved?.id ?? requested;
				// An unregistered id is most likely a host-native id: keep it as the
				// native fallback so pre-registry sessions still read correctly.
				nativeId = resolved?.nativeId ?? requested;
			} else {
				const current = currentSession(registry, exec.agent);
				if (current === undefined) {
					throw new MemoryToolError('no current session; pass session_id', 'MEMORY_SOURCE_MISSING');
				}
				unified = current.id;
				nativeId = current.nativeId;
			}
			const archives = archive.read(unified);
			if (archives.length > 0) {
				const turn = requestedTurn ?? archive.lastTurn(unified);
				if (turn === undefined) {
					throw new MemoryToolError('this session has no archived round', 'MEMORY_TURN_MISSING');
				}
				const sliced = archive.slice(unified, turn, before, after);
				if (!sliced.found) {
					throw new MemoryToolError(
						'turn ' + turn + ' not found; available turns: ' + availableTurns(archives),
						'MEMORY_TURN_NOT_FOUND'
					);
				}
				const title = await sessionTitle(ctx, registry, exec.signal, unified, nativeId);
				return formatRecall(
					{ header: { id: unified, createdAt: 0 }, rounds: sliced.rounds.map(toRound) },
					sliced.rounds.map(toRound),
					{ title, maxChars: config.maxRecallChars }
				);
			}
			const sessionQuery = getSessionQuery(ctx);
			if (sessionQuery === undefined || nativeId === undefined) {
				throw new MemoryToolError('session ' + unified + ' is not archived', 'MEMORY_SESSION_NOT_ARCHIVED');
			}
			let snapshot;
			try {
				snapshot = await loadRounds(sessionQuery, nativeId);
			} catch (error) {
				throw new MemoryToolError('could not read session ' + nativeId + ': ' + errorText(error), 'MEMORY_SESSION_READ_FAILED');
			}
			const turn = requestedTurn ?? snapshot.rounds[snapshot.rounds.length - 1]?.turn;
			if (turn === undefined) {
				throw new MemoryToolError('this session has no round', 'MEMORY_TURN_MISSING');
			}
			let rounds;
			try {
				rounds = selectRounds(snapshot.rounds, turn, before, after);
			} catch (error) {
				if (error instanceof RoundNotFoundError) {
					throw new MemoryToolError(error.message, 'MEMORY_TURN_NOT_FOUND');
				}
				throw error;
			}
			const record: SessionRecordLike = { header: snapshot.header, live: false, persisted: true };
			const titles = await resolveTitles(ctx, sessionQuery, [record], exec.signal);
			return formatRecall(snapshot, rounds, {
				title: titles.get(nativeId),
				maxChars: config.maxRecallChars
			});
		}
	});
	register({
		name: 'session_list',
		description:
			'List sessions newest first with cached titles. query filters id, title, or working directory; include_subagents defaults to false.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				query: { type: 'string', description: 'Case-insensitive substring filter over id, title, or cwd.' },
				include_subagents: {
					type: 'boolean',
					description: 'Include subagent sessions; default false.'
				},
				offset: {
					type: 'integer',
					minimum: 0,
					description: 'Zero-based page offset; default 0.'
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 50,
					description: 'Page size; default 20.'
				}
			}
		},
		output: { schema: { type: 'object' }, render: renderJson },
		execute: async (rawArgs, exec) => {
			const args = objectArgs(rawArgs);
			const sessionQuery = requireSessionQuery(ctx);
			const listed = await listSessions(ctx, sessionQuery, {
				query: optionalString(args, 'query'),
				includeSubagents: args['include_subagents'] === true,
				offset: clamp(optionalInteger(args, 'offset') ?? 0, 0, 1_000_000),
				limit: clamp(optionalInteger(args, 'limit') ?? config.sessionListLimit, 1, 50),
				signal: exec.signal
			});
			return {
				...listed,
				sessions: listed.sessions.map((row) => {
					const registered = registry.find('dsh', row.id);
					return {
						...row,
						id: registered?.id ?? row.id,
						nativeId: row.id,
						archived: registered === undefined ? false : archive.has(registered.id)
					};
				})
			};
		}
	});

	register({
		name: 'memory_search',
		description:
			'Search the archived rounds of every hosted agent (this host and opencode) by literal text. Returns session id, title, turn, and excerpts; use memory_recall for the full round. Falls back to this host\'s session-text search when the archive is empty.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				query: { type: 'string', description: 'Literal phrase to search; empty is rejected.' },
				session_id: {
					type: 'string',
					description: 'Search only this session. Omit to search recent sessions.'
				},
				max_sessions: {
					type: 'integer',
					minimum: 1,
					maximum: 200,
					description: 'Sessions to scan when no session_id is given; default 30.'
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 50,
					description: 'Maximum hits; default 8.'
				},
				include_subagents: {
					type: 'boolean',
					description: 'Include subagent sessions; default false.'
				}
			},
			required: ['query']
		},
		output: { schema: { type: 'object' }, render: renderJson },
		execute: async (rawArgs, exec) => {
			const args = objectArgs(rawArgs);
			const query = requiredString(args, 'query');
			const limit = clamp(optionalInteger(args, 'limit') ?? config.searchLimit, 1, 50);
			const maxSessions = clamp(
				optionalInteger(args, 'max_sessions') ?? config.maxSessionScan,
				1,
				200
			);
			const sessionQuery = getSessionQuery(ctx);
			const requested = optionalString(args, 'session_id');
			let scope: string | undefined;
			if (requested !== undefined && requested !== '') {
				const resolved = registry.resolve(requested);
				if (resolved === undefined) {
					throw new MemoryToolError('unknown session ' + requested, 'MEMORY_SESSION_NOT_FOUND');
				}
				scope = resolved.id;
			}
			const hits = archive
				.search(query, { limit, maxSessions })
				.filter((hit) => scope === undefined || hit.round.session === scope);
			if (archive.sessions({ limit: 1 }).length > 0) {
				return {
					hits: await Promise.all(
						hits.map(async (hit) => {
							const registered = registry.resolve(hit.round.session);
							const title = await sessionTitle(
								ctx,
								registry,
								exec.signal,
								hit.round.session,
								registered?.nativeId
							);
							return {
								sessionId: hit.round.session,
								nativeId: registered?.nativeId ?? null,
								agent: hit.round.agent,
								title: title ?? hit.round.session,
								turn: hit.round.turn,
								time: isoTime(hit.round.time),
								matched: hit.matched,
								user: hit.userExcerpt,
								assistant: hit.assistantExcerpt
							};
						})
					),
					scanned: maxSessions,
					errors: 0,
					truncated: hits.length >= limit,
					mode: 'archive' as const
				};
			}
			const required = requireSessionQuery(ctx);
			return searchSessions(ctx, required, {
				query,
				sessionId: undefined,
				includeSubagents: args['include_subagents'] === true,
				maxSessions,
				limit,
				signal: exec.signal
			});
		}
	});
}

/** The current agent's unified session, creating the registration on first use. */
function currentSession(
	registry: SessionRegistry,
	agent: AgentLike | undefined
): { id: string; nativeId: string } | undefined {
	if (agent === undefined) return undefined;
	const nativeId = agent.session.id;
	const existing = registry.find('dsh', nativeId);
	if (existing !== undefined) return { id: existing.id, nativeId };
	const created = registry.ensure('dsh', nativeId);
	return { id: created.id, nativeId };
}

function currentSessionId(registry: SessionRegistry, agent: AgentLike | undefined): string | null {
	return currentSession(registry, agent)?.id ?? null;
}

/** Project one archived round into the recall formatter's round shape. */
function toRound(round: ArchivedRound): Round {
	return {
		turn: round.turn,
		startSeq: 0,
		endSeq: 0,
		time: round.time,
		users: [...round.user],
		userSeqs: [],
		answer: round.answer,
		inProgress: false
	};
}

function availableTurns(rounds: readonly ArchivedRound[]): string {
	if (rounds.length === 0) return 'none';
	const first = rounds[0]?.turn;
	const last = rounds[rounds.length - 1]?.turn;
	return `${first ?? '?'}..${last ?? '?'}`;
}

/** Registry title first, then the host's folded title. */
async function sessionTitle(
	ctx: PluginContext,
	registry: SessionRegistry,
	signal: AbortSignal | undefined,
	unified: string,
	nativeId: string | undefined
): Promise<string | undefined> {
	const registered = registry.resolve(unified);
	if (registered?.title !== undefined && registered.title !== '') return registered.title;
	const sessionQuery = getSessionQuery(ctx);
	if (sessionQuery === undefined || nativeId === undefined) return undefined;
	try {
		const titles = await resolveTitles(
			ctx,
			sessionQuery,
			[{ header: { id: nativeId, createdAt: 0 }, live: false, persisted: true }],
			signal
		);
		return titles.get(nativeId);
	} catch {
		return undefined;
	}
}

async function currentTurn(
	ctx: PluginContext,
	agent: AgentLike | undefined,
	cache: Map<string, TurnCacheEntry>
): Promise<number | null> {
	if (agent === undefined) return null;
	const sessionQuery = getSessionQuery(ctx);
	if (sessionQuery === undefined) return null;
	const sessionId = agent.session.id;
	const cached = cache.get(sessionId);
	if (cached !== undefined && cached.logLength === agent.session.seq) return cached.turn;
	try {
		const events = await sessionQuery.listEvents(sessionId);
		let lastStart: { seq: number } | undefined;
		for (const event of events) {
			if (event.type === 'turn/start') lastStart = { seq: event.seq };
		}
		if (lastStart === undefined) {
			cache.set(sessionId, { logLength: agent.session.seq, turn: null });
			return null;
		}
		const window = await sessionQuery.readEvent({ sessionId, seq: lastStart.seq });
		const turn = window.target?.data?.turn;
		const value =
			typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null;
		cache.set(sessionId, { logLength: agent.session.seq, turn: value });
		return value;
	} catch {
		cache.set(sessionId, { logLength: agent.session.seq, turn: null });
		return null;
	}
}

function getSessionQuery(ctx: PluginContext): SessionQueryLike | undefined {
	return ctx.get('sessionQuery') as SessionQueryLike | undefined;
}

function requireSessionQuery(ctx: PluginContext): SessionQueryLike {
	const service = getSessionQuery(ctx);
	if (service === undefined) {
		throw new MemoryToolError(
			'session query service is unavailable in this deployment',
			'MEMORY_SESSION_QUERY_UNAVAILABLE'
		);
	}
	return service;
}

function assertWritable(exec: ToolRunContextLike, config: MemoryConfig): void {
	if (exec.agent?.session.header.origin === 'subagent' && !config.allowSubagentWrites) {
		throw new MemoryToolError(
			'subagent sessions cannot write agent memory (allowSubagentWrites is false)',
			'MEMORY_SUBAGENT_WRITE_DENIED'
		);
	}
}

function objectArgs(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new MemoryToolError('arguments must be a JSON object', 'MEMORY_INVALID_ARGUMENTS');
	}
	return value as Record<string, unknown>;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') {
		throw new MemoryToolError(`${key} must be a string`, 'MEMORY_INVALID_ARGUMENTS');
	}
	return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
	const value = optionalString(args, key);
	if (value === undefined || value.trim() === '') {
		throw new MemoryToolError(`${key} must be a non-empty string`, 'MEMORY_INVALID_ARGUMENTS');
	}
	return value;
}

function requiredText(args: Record<string, unknown>, key: string): string {
	const value = requiredString(args, key);
	if (value.trim() === '') {
		throw new MemoryToolError(`${key} must be non-empty`, 'MEMORY_INVALID_ARGUMENTS');
	}
	return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw new MemoryToolError(`${key} must be an integer`, 'MEMORY_INVALID_ARGUMENTS');
	}
	return value;
}

function descriptionInputOf(args: Record<string, unknown>): string | null | undefined {
	const value = optionalString(args, 'description');
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length > MAX_DESCRIPTION) {
		throw new MemoryToolError(
			`description is ${trimmed.length} chars; the limit is ${MAX_DESCRIPTION}`,
			'MEMORY_INVALID_ARGUMENTS'
		);
	}
	return trimmed;
}

function validateKey(value: string): string {
	const key = value.trim();
	if (!KEY_PATTERN.test(key)) {
		throw new MemoryToolError(
			'key must be 1-80 characters of letters, digits, or . _ : / - (and @global)',
			'MEMORY_INVALID_KEY'
		);
	}
	return key;
}

function entryView(key: string, entry: MemoryEntry): Record<string, unknown> {
	return {
		key,
		value: entry.value,
		description: entry.description ?? null,
		revision: entry.revision ?? null,
		createdAt: isoTime(entry.createdAt),
		updatedAt: isoTime(entry.updatedAt)
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function isoTime(value: number): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderJson(_args: unknown, value: any): ContentBlock[] {
	return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function renderText(_args: unknown, value: any): ContentBlock[] {
	return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}