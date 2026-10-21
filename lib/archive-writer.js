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
import { buildRounds } from './core/rounds.js';
/** Install the live archive writer. */
export function installArchiveWriter(ctx, archive, registry, config) {
    if (!config.archive)
        return;
    const buffers = new WeakMap();
    const flush = (session, events) => {
        if (!shouldArchive(session, config))
            return;
        const unified = registry.ensure('dsh', session.id);
        for (const round of buildRounds(events)) {
            const archived = toArchived(round, unified.id);
            if (archived === undefined)
                continue;
            try {
                archive.append(archived);
            }
            catch (error) {
                ctx.logger.warn?.(`[one-memory] archive append failed: ${String(error)}`);
            }
        }
        registry.touch(unified.id);
    };
    ctx.effect(() => ctx.on('session/event', (payload) => {
        const session = payload?.session;
        const event = payload?.event;
        if (session === undefined || event === undefined)
            return;
        if (!shouldArchive(session, config))
            return;
        const buffer = buffers.get(session) ?? [];
        buffer.push(event);
        if (buffer.length > 20_000)
            buffer.splice(0, buffer.length - 10_000);
        buffers.set(session, buffer);
        if (event.type === 'turn/end') {
            buffers.set(session, []);
            try {
                flush(session, buffer);
            }
            catch (error) {
                ctx.logger.warn?.(`[one-memory] archive flush failed: ${String(error)}`);
            }
        }
    }));
}
/**
 * Backfill one session from its native log when the archive has no row for it.
 * Called when an agent is created, which covers a restart and a plugin
 * installed after the session began.
 */
export async function backfillSession(ctx, archive, registry, config, agent) {
    if (!config.archive || !config.archiveBackfill)
        return 0;
    const session = agent?.session;
    if (session === undefined)
        return 0;
    if (!shouldArchive(session, config))
        return 0;
    const unified = registry.ensure('dsh', session.id);
    if (archive.has(unified.id))
        return 0;
    const sessionQuery = ctx.get('sessionQuery');
    if (sessionQuery === undefined)
        return 0;
    try {
        const snapshot = await sessionQuery.readSession(session.id);
        let written = 0;
        for (const round of buildRounds(snapshot.events ?? [])) {
            const archived = toArchived(round, unified.id);
            if (archived === undefined)
                continue;
            archive.append(archived);
            written += 1;
        }
        if (written > 0) {
            ctx.logger.info?.(`[one-memory] backfilled ${written} round(s) for ${session.id} (${unified.id})`);
        }
        return written;
    }
    catch (error) {
        ctx.logger.warn?.(`[one-memory] backfill failed for ${session.id}: ${String(error)}`);
        return 0;
    }
}
function shouldArchive(session, config) {
    if (!config.archive)
        return false;
    return session.header.origin !== 'subagent';
}
function toArchived(round, session) {
    if (round.users.length === 0 && round.answer === '')
        return undefined;
    return {
        agent: 'dsh',
        session,
        turn: round.turn,
        time: round.time,
        user: [...round.users],
        answer: round.answer
    };
}
