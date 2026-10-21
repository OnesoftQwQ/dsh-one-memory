/**
 * Session listing and message search.
 *
 * `session_list` is a zero-log-read listing: titles come from the live
 * projection registry or the persisted projection cache. `session_search`
 * prefers the SQLite FTS backend, restricts hits to `user/message` and
 * `assistant/message`, and maps each hit to its projected round. When the FTS
 * service is disabled or fails, it falls back to a literal scan of the most
 * recent sessions.
 *
 * @module one-memory/sessions
 */

import {
	type PluginContext,
	type SessionProjectionCacheLike,
	type SessionProjectionsLike,
	type SessionQueryLike,
	type SessionRecordLike,
	type SessionsLike
} from './context.js';
import {
	buildRounds,
	excerptText,
	loadRounds,
	normalize,
	queryTerms,
	roundForSeq,
	searchRounds,
	type Round
} from './rounds.js';

/** One session-list row. */
export interface SessionListItem {
	id: string;
	title: string;
	createdAt: string;
	cwd?: string;
	live: boolean;
	persisted: boolean;
	origin?: string;
	parentSession?: string;
}

/** Result of `session_list`. */
export interface SessionListResult {
	sessions: SessionListItem[];
	total: number;
	matched: number;
	offset: number;
	limit: number;
	truncated: boolean;
}

/** One message search hit. */
export interface SessionSearchHit {
	sessionId: string;
	title: string;
	turn: number;
	time: string;
	matched: 'user' | 'assistant' | 'both';
	user: string;
	assistant: string;
}

/** Result of `session_search`. */
export interface SessionSearchResult {
	hits: SessionSearchHit[];
	scanned: number;
	errors: number;
	truncated: boolean;
	mode: 'fts' | 'literal';
}

/** List options. */
export interface SessionListOptions {
	query?: string;
	includeSubagents?: boolean;
	offset?: number;
	limit: number;
	signal?: AbortSignal;
}

/** Search options. */
export interface SessionSearchOptions {
	query: string;
	sessionId?: string;
	includeSubagents?: boolean;
	maxSessions: number;
	limit: number;
	signal?: AbortSignal;
}

const TITLE_KEYS = ['title'] as const;
const MESSAGE_TYPES = ['user/message', 'assistant/message'] as const;

/** Resolve one title from the live projection registry or the persisted cache. */
export function titleFor(ctx: PluginContext, record: SessionRecordLike): string | undefined {
	try {
		const sessions = ctx.get('sessions') as SessionsLike | undefined;
		const live = sessions?.get(record.header.id);
		if (live !== undefined) {
			const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined;
			const title = cleanTitle(projections?.snapshot(live, TITLE_KEYS)?.values.title);
			if (title !== undefined) return title;
		}
		const cache = ctx.get('sessionProjectionCache') as SessionProjectionCacheLike | undefined;
		return cleanTitle(cache?.cachedSnapshot(record.header, TITLE_KEYS)?.values.title);
	} catch {
		return undefined;
	}
}

/** Resolve titles for a bounded set of records, falling back to the query service. */
export async function resolveTitles(
	ctx: PluginContext,
	sessionQuery: SessionQueryLike,
	records: readonly SessionRecordLike[],
	signal?: AbortSignal
): Promise<Map<string, string>> {
	const titles = new Map<string, string>();
	const missing: string[] = [];
	for (const record of records) {
		const id = record.header.id;
		if (titles.has(id)) continue;
		const title = titleFor(ctx, record);
		if (title !== undefined) titles.set(id, title);
		else missing.push(id);
	}
	if (missing.length === 0) return titles;
	if (typeof sessionQuery.readTitleSnapshots === 'function') {
		try {
			const results = await sessionQuery.readTitleSnapshots(missing, signal);
			for (const result of results ?? []) {
				if (result.status !== 'fulfilled') continue;
				const title = cleanTitle(result.value?.title?.title);
				if (title !== undefined) titles.set(result.sessionId, title);
			}
		} catch {
			// Fall through to the single-title path.
		}
	}
	for (const id of missing) {
		if (titles.has(id)) continue;
		try {
			const title = cleanTitle((await sessionQuery.readTitle(id, signal))?.title);
			if (title !== undefined) titles.set(id, title);
		} catch {
			// A missing title is not a failure.
		}
	}
	return titles;
}

/** List sessions, newest first, with cached titles. */
export async function listSessions(
	ctx: PluginContext,
	sessionQuery: SessionQueryLike,
	options: SessionListOptions
): Promise<SessionListResult> {
	const records = await sessionQuery.listSessions(options.signal);
	const visible =
		options.includeSubagents === true
			? records
			: records.filter((record) => record.header.origin !== 'subagent');
	const needle = normalize(options.query ?? '');
	const matched =
		needle === ''
			? visible
			: visible.filter((record) => {
					const title = titleFor(ctx, record) ?? '';
					return (
						normalize(record.header.id).includes(needle) ||
						normalize(title).includes(needle) ||
						normalize(record.header.cwd ?? '').includes(needle)
					);
				});
	const offset = Math.max(0, Math.trunc(options.offset ?? 0));
	const page = matched.slice(offset, offset + options.limit);
	const titles = await resolveTitles(ctx, sessionQuery, page, options.signal);
	const sessions = page.map((record) => toListRow(record, titles.get(record.header.id)));
	return {
		sessions,
		total: visible.length,
		matched: matched.length,
		offset,
		limit: options.limit,
		truncated: offset + page.length < matched.length
	};
}

/** Search messages across recent sessions or one explicit session. */
export async function searchSessions(
	ctx: PluginContext,
	sessionQuery: SessionQueryLike,
	options: SessionSearchOptions
): Promise<SessionSearchResult> {
	const query = options.query.trim();
	if (query === '') throw new Error('query must be non-empty');
	const records = await sessionQuery.listSessions(options.signal);
	let explicit: SessionRecordLike | undefined;
	if (options.sessionId !== undefined) {
		explicit = records.find((record) => record.header.id === options.sessionId);
		if (explicit === undefined) throw new Error(`session not found: ${options.sessionId}`);
	}
	try {
		return await searchWithFts(ctx, sessionQuery, records, query, options, explicit);
	} catch (error) {
		if (options.signal?.aborted === true || isAbort(error)) throw error;
	}
	return searchLiteral(ctx, sessionQuery, records, query, options, explicit);
}

async function searchWithFts(
	ctx: PluginContext,
	sessionQuery: SessionQueryLike,
	records: readonly SessionRecordLike[],
	query: string,
	options: SessionSearchOptions,
	explicit: SessionRecordLike | undefined
): Promise<SessionSearchResult> {
	let candidates: SessionRecordLike[];
	let hasMore = false;
	if (explicit !== undefined) {
		candidates = [explicit];
	} else {
		const maxSessions = Math.min(100, options.maxSessions);
		const page = await sessionQuery.searchSessions(
			{
				query,
				eventFilters: [{ kind: 'type', values: [...MESSAGE_TYPES] }],
				limit: Math.min(100, Math.max(1, maxSessions * 2))
			},
			{ signal: options.signal }
		);
		const byId = new Map(records.map((record) => [record.header.id, record]));
		candidates = [];
		for (const item of page.items) {
			if (options.includeSubagents !== true && item.header.origin === 'subagent') continue;
			candidates.push(byId.get(item.header.id) ?? item);
			if (candidates.length >= maxSessions) break;
		}
		hasMore = page.nextCursor !== undefined || page.items.length > candidates.length;
		if (candidates.length === 0) {
			return { hits: [], scanned: 0, errors: 0, truncated: hasMore, mode: 'fts' };
		}
	}
	const collected = await collectFtsHits(sessionQuery, candidates, query, options);
	const hits = collected.hits.slice(0, options.limit);
	const uniqueRecords = uniqueByRecord(collected.hits.map((hit) => hit.record));
	const titles = await resolveTitles(ctx, sessionQuery, uniqueRecords, options.signal);
	return {
		hits: hits.map((hit) => toSearchHit(hit, titles.get(hit.record.header.id))),
		scanned: candidates.length,
		errors: collected.errors,
		truncated: hasMore || collected.hits.length > options.limit,
		mode: 'fts'
	};
}

interface InternalHit {
	record: SessionRecordLike;
	round: Round;
	matched: 'user' | 'assistant' | 'both';
	userExcerpt: string;
	assistantExcerpt: string;
	rank: number;
}

async function collectFtsHits(
	sessionQuery: SessionQueryLike,
	candidates: readonly SessionRecordLike[],
	query: string,
	options: SessionSearchOptions
): Promise<{ hits: InternalHit[]; errors: number }> {
	const ordered = new Map<string, InternalHit>();
	let errors = 0;
	let attempted = 0;
	for (const record of candidates) {
		options.signal?.throwIfAborted();
		let eventPage;
		try {
			eventPage = await sessionQuery.searchEvents(
				{
					sessionId: record.header.id,
					query,
					filters: [{ kind: 'type', values: [...MESSAGE_TYPES] }],
					limit: 50
				},
				{ signal: options.signal }
			);
		} catch (error) {
			if (options.signal?.aborted === true || isAbort(error)) throw error;
			// The first FTS call failing means the backend is unavailable (for
			// example SESSION_QUERY_SEARCH_DISABLED); let the caller fall back to
			// the literal scan. Later per-session failures are counted.
			if (attempted === 0) throw error;
			errors += 1;
			continue;
		}
		attempted += 1;
		if (eventPage.items.length === 0) continue;
		let rounds: Round[];
		try {
			rounds = buildRounds((await sessionQuery.readSession(record.header.id)).events);
		} catch (error) {
			if (options.signal?.aborted === true || isAbort(error)) throw error;
			errors += 1;
			continue;
		}
		const terms = queryTerms(query);
		for (const item of eventPage.items) {
			const round = roundForSeq(rounds, item.seq);
			if (round === undefined) continue;
			const isUser = round.userSeqs.includes(item.seq);
			const isAnswer = round.answerSeq === item.seq;
			if (!isUser && !isAnswer) continue;
			const key = `${record.header.id}:${round.turn}`;
			const existing = ordered.get(key);
			if (existing !== undefined) {
				const next = existing.matched;
				if (
					(next === 'assistant' && isUser) ||
					(next === 'user' && isAnswer)
				) {
					existing.matched = 'both';
				}
				continue;
			}
			ordered.set(key, {
				record,
				round,
				matched: isUser && isAnswer ? 'both' : isUser ? 'user' : 'assistant',
				userExcerpt: excerptText(round.users.join('\n'), terms, 180),
				assistantExcerpt: excerptText(round.answer, terms, 180),
				rank: ordered.size
			});
			if (ordered.size >= options.limit * 4) break;
		}
		if (ordered.size >= options.limit * 4) break;
	}
	return { hits: [...ordered.values()].sort((left, right) => left.rank - right.rank), errors };
}

async function searchLiteral(
	ctx: PluginContext,
	sessionQuery: SessionQueryLike,
	records: readonly SessionRecordLike[],
	query: string,
	options: SessionSearchOptions,
	explicit: SessionRecordLike | undefined
): Promise<SessionSearchResult> {
	const candidates =
		explicit !== undefined
			? [explicit]
			: records
					.filter((record) => options.includeSubagents === true || record.header.origin !== 'subagent')
					.slice(0, options.maxSessions);
	const collected: Array<{ record: SessionRecordLike; match: ReturnType<typeof searchRounds>[number] }> = [];
	let errors = 0;
	let index = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const position = index;
			index += 1;
			if (position >= candidates.length) return;
			const record = candidates[position];
			if (record === undefined) return;
			options.signal?.throwIfAborted();
			try {
				const snapshot = await loadRounds(sessionQuery, record.header.id);
				for (const match of searchRounds(snapshot.rounds, query, 180)) {
					collected.push({ record, match });
				}
			} catch (error) {
				if (options.signal?.aborted === true || isAbort(error)) throw error;
				errors += 1;
			}
		}
	};
	const concurrency = Math.min(4, Math.max(1, candidates.length));
	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	collected.sort(
		(left, right) =>
			right.match.score - left.match.score ||
			right.record.header.createdAt - left.record.header.createdAt ||
			left.match.round.turn - right.match.round.turn
	);
	const selected = collected.slice(0, options.limit);
	const titles = await resolveTitles(
		ctx,
		sessionQuery,
		uniqueByRecord(selected.map((entry) => entry.record)),
		options.signal
	);
	const filtered =
		explicit !== undefined
			? candidates.length
			: records.filter(
					(record) => options.includeSubagents === true || record.header.origin !== 'subagent'
				).length;
	return {
		hits: selected.map((entry) => ({
			sessionId: entry.record.header.id,
			title: titles.get(entry.record.header.id) ?? entry.record.header.id,
			turn: entry.match.round.turn,
			time: isoTime(entry.match.round.time),
			matched: entry.match.matched,
			user: entry.match.userExcerpt,
			assistant: entry.match.assistantExcerpt
		})),
		scanned: candidates.length,
		errors,
		truncated: collected.length > options.limit || (explicit === undefined && filtered > options.maxSessions),
		mode: 'literal'
	};
}

function toListRow(record: SessionRecordLike, title: string | undefined): SessionListItem {
	const row: SessionListItem = {
		id: record.header.id,
		title: title ?? record.header.id,
		createdAt: isoTime(record.header.createdAt),
		live: record.live,
		persisted: record.persisted
	};
	if (record.header.cwd !== undefined) row.cwd = record.header.cwd;
	if (record.header.origin !== undefined) row.origin = record.header.origin;
	if (record.header.parentSession !== undefined) row.parentSession = record.header.parentSession;
	return row;
}

function toSearchHit(hit: InternalHit, title: string | undefined): SessionSearchHit {
	return {
		sessionId: hit.record.header.id,
		title: title ?? hit.record.header.id,
		turn: hit.round.turn,
		time: isoTime(hit.round.time),
		matched: hit.matched,
		user: hit.userExcerpt,
		assistant: hit.assistantExcerpt
	};
}

function uniqueByRecord(records: readonly SessionRecordLike[]): SessionRecordLike[] {
	const seen = new Set<string>();
	const unique: SessionRecordLike[] = [];
	for (const record of records) {
		if (seen.has(record.header.id)) continue;
		seen.add(record.header.id);
		unique.push(record);
	}
	return unique;
}

function cleanTitle(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const title = value.trim();
	return title === '' ? undefined : title.slice(0, 200);
}

function isoTime(value: number): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isAbort(error: unknown): boolean {
	return (
		(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
		false
	);
}
