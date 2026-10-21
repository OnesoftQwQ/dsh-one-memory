/**
 * Cross-agent round archive, stored in the shared SQLite database.
 *
 * A round is one direct user message (or the round's steering messages) plus
 * the final assistant text. Tool calls, reasoning, injected context, and
 * intermediate assistant text are never archived, so the archive stays small
 * and host-neutral: recall and search read this table instead of another
 * framework's private session format.
 *
 * Rows are keyed by the unified session id from the session registry, so a
 * citation such as `[1](m-lq2x9d3f:12)` resolves the same way no matter which
 * agent produced it.
 *
 * @module one-memory/archive
 */
import { integer, text } from './db.js';
import { countOccurrences, excerptText, normalize, queryTerms } from './text.js';
const COLUMNS = 'agent, session, turn, time, user_text, answer, origin';
/**
 * Build the archive over an open database.
 * @param options - connection and retention.
 */
export function createArchive(options) {
    const db = options.db;
    const maxRounds = options.maxRoundsPerSession ?? 2000;
    const warn = options.warn ?? (() => { });
    function append(round) {
        const userText = round.user.join('\n');
        const searchText = normalize(`${userText}\n${round.answer}`);
        db.prepare(`INSERT INTO round (${COLUMNS}, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(agent, session, turn) DO UPDATE SET
				time = excluded.time,
				user_text = excluded.user_text,
				answer = excluded.answer,
				search_text = excluded.search_text,
				origin = excluded.origin`).run(round.agent, round.session, round.turn, round.time, userText, round.answer, round.origin ?? null, searchText);
        trim(round.agent, round.session);
    }
    function trim(agent, session) {
        try {
            db.prepare(`DELETE FROM round WHERE agent = ? AND session = ? AND turn NOT IN (
					SELECT turn FROM round WHERE agent = ? AND session = ? ORDER BY turn DESC LIMIT ?
				)`).run(agent, session, agent, session, maxRounds);
        }
        catch (error) {
            warn(`[one-memory] archive trim failed: ${String(error)}`);
        }
    }
    function read(session) {
        const rows = db
            .prepare(`SELECT ${COLUMNS} FROM round WHERE session = ? ORDER BY turn`)
            .all(session);
        const out = [];
        for (const row of rows) {
            const round = rowToRound(row);
            if (round !== undefined)
                out.push(round);
        }
        return out;
    }
    function has(session) {
        const row = db.prepare('SELECT 1 AS hit FROM round WHERE session = ? LIMIT 1').get(session);
        return row !== undefined;
    }
    function lastTurn(session) {
        const row = db.prepare('SELECT MAX(turn) AS turn FROM round WHERE session = ?').get(session);
        return integer(row?.turn);
    }
    function slice(session, turn, before, after) {
        const rounds = read(session);
        const index = rounds.findIndex((round) => round.turn === turn);
        if (index < 0) {
            return { rounds: [], found: false, turns: rounds.map((round) => round.turn) };
        }
        const start = Math.max(0, index - Math.max(0, before));
        const end = Math.min(rounds.length, index + Math.max(0, after) + 1);
        return { rounds: rounds.slice(start, end), found: true, turns: [] };
    }
    function search(query, searchOptions) {
        const terms = queryTerms(query);
        if (terms.length === 0)
            return [];
        const limit = searchOptions?.limit ?? 20;
        const maxSessions = searchOptions?.maxSessions ?? 200;
        const recent = sessions({ limit: maxSessions }).map((entry) => entry.session);
        if (recent.length === 0)
            return [];
        const placeholders = recent.map(() => '?').join(', ');
        const likeClause = terms.map(() => "search_text LIKE ? ESCAPE '\\'").join(' AND ');
        const rows = db
            .prepare(`SELECT ${COLUMNS} FROM round WHERE session IN (${placeholders}) AND ${likeClause} ORDER BY time DESC LIMIT ?`)
            .all(...recent, ...terms.map((term) => `%${escapeLike(term)}%`), limit * 8);
        const hits = [];
        for (const row of rows) {
            const round = rowToRound(row);
            if (round === undefined)
                continue;
            const userNormalized = normalize(round.user.join('\n'));
            const answerNormalized = normalize(round.answer);
            const userAll = terms.every((term) => userNormalized.includes(term));
            const answerAll = terms.every((term) => answerNormalized.includes(term));
            let score = 0;
            for (const term of terms) {
                score += countOccurrences(userNormalized, term) * 2;
                score += countOccurrences(answerNormalized, term);
            }
            hits.push({
                round,
                score,
                matched: userAll && answerAll ? 'both' : userAll ? 'user' : 'assistant',
                userExcerpt: excerptText(round.user.join('\n'), terms, 180),
                assistantExcerpt: excerptText(round.answer, terms, 180)
            });
        }
        return hits
            .sort((left, right) => right.score - left.score || right.round.time - left.round.time)
            .slice(0, limit);
    }
    function sessions(listOptions) {
        const limit = listOptions?.limit ?? 100;
        const rows = db
            .prepare(`SELECT agent, session, COUNT(*) AS n, MAX(time) AS last, MIN(turn) AS first_turn
				 FROM round GROUP BY agent, session ORDER BY last DESC LIMIT ?`)
            .all(limit);
        const out = [];
        for (const row of rows) {
            const record = row;
            const agent = text(record['agent']);
            const session = text(record['session']);
            if (agent === undefined || session === undefined)
                continue;
            out.push({
                agent,
                session,
                rounds: Number(record['n'] ?? 0) || 0,
                lastTime: Number(record['last'] ?? 0) || 0
            });
        }
        return out;
    }
    return { append, read, has, lastTurn, slice, search, sessions };
}
function rowToRound(row) {
    if (row === null || typeof row !== 'object')
        return undefined;
    const record = row;
    const agent = text(record['agent']);
    const session = text(record['session']);
    const turn = integer(record['turn']);
    const answer = text(record['answer']);
    const userText = text(record['user_text']);
    if (agent === undefined || session === undefined || turn === undefined)
        return undefined;
    const round = {
        agent,
        session,
        turn,
        time: integer(record['time']) ?? 0,
        user: userText === undefined || userText === '' ? [] : userText.split('\n'),
        answer: answer ?? ''
    };
    const origin = text(record['origin']);
    if (origin !== undefined)
        round.origin = origin;
    return round;
}
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
