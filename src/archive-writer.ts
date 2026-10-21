/**
 * DSH-side archive writer.
 *
 * The writer listens to the post-commit `session/event` feed and buffers the
 * events of the open turn. When `turn/end` arrives it projects that turn with
 * the same rules as `memory_recall` (direct user messages plus the final
 * assistant text), resolves the unified session id, appends one archive row,
 * and clears the buffer.
 *
 * Subagent sessions are skipped: their rounds belong to a delegated task, not
 * to the user's own conversation history.
 *
 * @module one-memory/archive-writer
 */

import type { AgentLike, PluginContext, SessionEventLike, SessionLike } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import type { Archive, ArchivedRound } from './core/archive.js';
import type { SessionRegistry } from './core/sessions-registry.js';
import { buildRounds, type Round } from './core/rounds.js';

interface SessionEventPayload {
	readonly session?: SessionLike;
	readonly event?: SessionEventLike;
}

/** Install the live archive writer. */
export function installArchiveWriter(
	ctx: PluginContext,
	archive: Archive,
	registry: SessionRegistry,
	config: MemoryConfig
): void {
	if (!config.archive) return;
	const buffers = new WeakMap<SessionLike, SessionEventLike[]>();

	const flush = (session: SessionLike, events: SessionEventLike[]): void => {
		if (!shouldArchive(session, config)) return;
		const unified = registry.ensure('dsh', session.id);
		for (const round of buildRounds(events)) {
			const archived = toArchived(round, unified.id);
			if (archived === undefined) continue;
			try {
				archive.append(archived);
			} catch (error) {
				ctx.logger.warn?.(`[one-memory] archive append failed: ${String(error)}`);
			}
		}
		registry.touch(unified.id);
	};

	ctx.effect(() =>
		ctx.on('session/event', (payload: SessionEventPayload) => {
			const session = payload?.session;
			const event = payload?.event;
			if (session === undefined || event === undefined) return;
			if (!shouldArchive(session, config)) return;
			const buffer = buffers.get(session) ?? [];
			buffer.push(event);
			if (buffer.length > 20_000) buffer.splice(0, buffer.length - 10_000);
			buffers.set(session, buffer);
			if (event.type === 'turn/end') {
				buffers.set(session, []);
				try {
					flush(session, buffer);
				} catch (error) {
					ctx.logger.warn?.(`[one-memory] archive flush failed: ${String(error)}`);
				}
			}
		})
	);
}

/**
 * Backfill one session from its native log when the archive has no row for it.
 * Called when an agent is created, which covers a restart and a plugin
 * installed after the session began.
 */
export async function backfillSession(
	ctx: PluginContext,
	archive: Archive,
	registry: SessionRegistry,
	config: MemoryConfig,
	agent: AgentLike | undefined
): Promise<number> {
	if (!config.archive || !config.archiveBackfill) return 0;
	const session = agent?.session;
	if (session === undefined) return 0;
	if (!shouldArchive(session, config)) return 0;
	const unified = registry.ensure('dsh', session.id);
	if (archive.has(unified.id)) return 0;
	const sessionQuery = ctx.get('sessionQuery') as
		| { readSession(id: string): Promise<{ events: SessionEventLike[] }> }
		| undefined;
	if (sessionQuery === undefined) return 0;
	try {
		const snapshot = await sessionQuery.readSession(session.id);
		let written = 0;
		for (const round of buildRounds(snapshot.events ?? [])) {
			const archived = toArchived(round, unified.id);
			if (archived === undefined) continue;
			archive.append(archived);
			written += 1;
		}
		if (written > 0) {
			ctx.logger.info?.(`[one-memory] backfilled ${written} round(s) for ${session.id} (${unified.id})`);
		}
		return written;
	} catch (error) {
		ctx.logger.warn?.(`[one-memory] backfill failed for ${session.id}: ${String(error)}`);
		return 0;
	}
}

function shouldArchive(session: SessionLike, config: MemoryConfig): boolean {
	if (!config.archive) return false;
	return session.header.origin !== 'subagent';
}

function toArchived(round: Round, session: string): ArchivedRound | undefined {
	if (round.users.length === 0 && round.answer === '') return undefined;
	return {
		agent: 'dsh',
		session,
		turn: round.turn,
		time: round.time,
		user: [...round.users],
		answer: round.answer
	};
}
