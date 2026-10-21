/**
 * Projection of one session's raw log into conversation rounds.
 *
 * A round is one model turn: one or more direct user messages plus the final
 * assistant text. Tool calls, tool results, reasoning blocks, injected context,
 * system/developer messages, and intermediate assistant text never enter the
 * projection.
 *
 * @module one-memory/rounds
 */
import { contentText } from './context.js';
import { countOccurrences, excerptText, normalize, queryTerms } from './text.js';
const TURN_START = 'turn/start';
const TURN_END = 'turn/end';
/**
 * Project raw events into rounds. Events before the first `turn/start` are
 * ignored. Duplicate turn blocks (resume) are merged by turn number.
 * @param events - raw session events, any order.
 */
export function buildRounds(events) {
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    const groups = [];
    let current;
    for (const event of ordered) {
        if (event.type === TURN_START && isTurnNumber(event.data?.turn)) {
            if (current !== undefined) {
                current.inProgress = true;
                groups.push(current);
            }
            current = {
                turn: Number(event.data.turn),
                startSeq: event.seq,
                endSeq: event.seq,
                time: event.time,
                events: [event],
                inProgress: false
            };
            continue;
        }
        if (current === undefined)
            continue;
        current.events.push(event);
        current.endSeq = event.seq;
        if (event.type === TURN_END && event.data?.turn === current.turn) {
            current.endReason = reasonText(event.data?.reason);
            current.inProgress = false;
            groups.push(current);
            current = undefined;
        }
    }
    if (current !== undefined) {
        current.inProgress = true;
        groups.push(current);
    }
    const merged = new Map();
    for (const group of groups) {
        const previous = merged.get(group.turn);
        if (previous === undefined) {
            merged.set(group.turn, group);
            continue;
        }
        previous.events.push(...group.events);
        previous.endSeq = Math.max(previous.endSeq, group.endSeq);
        previous.inProgress = group.inProgress;
        previous.endReason = group.endReason ?? previous.endReason;
    }
    return [...merged.values()].sort((left, right) => left.startSeq - right.startSeq).map(projectGroup);
}
function projectGroup(group) {
    const users = [];
    const userSeqs = [];
    let lastToolSeq = -1;
    for (const event of group.events) {
        if (event.type === 'tool/call' || event.type === 'tool/result') {
            lastToolSeq = Math.max(lastToolSeq, event.seq);
        }
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
            const text = contentText(event.data?.content);
            if (text !== '') {
                users.push(text);
                userSeqs.push(event.seq);
            }
        }
    }
    let answer = '';
    let answerSeq;
    let fallback;
    for (const event of group.events) {
        if (event.type !== 'assistant/message')
            continue;
        const text = contentText(event.data?.message?.content);
        if (text === '')
            continue;
        fallback = { text, seq: event.seq };
        if (event.seq > lastToolSeq) {
            answer = text;
            answerSeq = event.seq;
        }
    }
    if (answer === '' && fallback !== undefined) {
        answer = fallback.text;
        answerSeq = fallback.seq;
    }
    const round = {
        turn: group.turn,
        startSeq: group.startSeq,
        endSeq: group.endSeq,
        time: group.time,
        users,
        userSeqs,
        answer,
        inProgress: group.inProgress
    };
    if (answerSeq !== undefined)
        round.answerSeq = answerSeq;
    if (group.endReason !== undefined)
        round.endReason = group.endReason;
    return round;
}
function isTurnNumber(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function reasonText(reason) {
    if (typeof reason === 'string')
        return reason;
    if (reason !== null && typeof reason === 'object') {
        const value = reason;
        if (typeof value.kind === 'string') {
            if (value.kind === 'error' &&
                value.error !== null &&
                typeof value.error === 'object' &&
                typeof value.error.message === 'string') {
                return `error: ${value.error.message}`;
            }
            return value.kind;
        }
    }
    return undefined;
}
/** Read and project one session. */
export async function loadRounds(sessionQuery, sessionId) {
    const snapshot = await sessionQuery.readSession(sessionId);
    return { header: snapshot.session, rounds: buildRounds(snapshot.events) };
}
/** Thrown when a requested turn is absent from the session. */
export class RoundNotFoundError extends Error {
    available;
    constructor(turn, available) {
        const range = available.length === 0
            ? 'none'
            : `${available[0] ?? '?'}..${available[available.length - 1] ?? '?'}`;
        super(`turn ${turn} not found; available turns: ${range}`);
        this.name = 'RoundNotFoundError';
        this.available = available;
    }
}
/**
 * Select one turn plus `before`/`after` adjacent turns.
 * @throws {RoundNotFoundError} when the turn is absent.
 */
export function selectRounds(rounds, turn, before, after) {
    const index = rounds.findIndex((round) => round.turn === turn);
    if (index < 0)
        throw new RoundNotFoundError(turn, rounds.map((round) => round.turn));
    const start = Math.max(0, index - Math.max(0, before));
    const end = Math.min(rounds.length, index + Math.max(0, after) + 1);
    return rounds.slice(start, end);
}
/** Find the round containing a raw event seq. */
export function roundForSeq(rounds, seq) {
    return rounds.find((round) => seq >= round.startSeq && seq <= round.endSeq);
}
/**
 * Literal, case-insensitive, whitespace-flexible search over the projected
 * user and final-answer text of every round. All whitespace-separated query
 * terms must occur somewhere in the round.
 */
export function searchRounds(rounds, query, excerptChars = 180) {
    const terms = queryTerms(query);
    if (terms.length === 0)
        return [];
    const matches = [];
    for (const round of rounds) {
        const userText = round.users.join('\n');
        const answerText = round.answer;
        const userNormalized = normalize(userText);
        const answerNormalized = normalize(answerText);
        const combined = `${userNormalized}\n${answerNormalized}`;
        if (!terms.every((term) => combined.includes(term)))
            continue;
        const userAll = terms.every((term) => userNormalized.includes(term));
        const answerAll = terms.every((term) => answerNormalized.includes(term));
        const matched = userAll && answerAll ? 'both' : userAll ? 'user' : answerAll ? 'assistant' : 'both';
        let score = 0;
        for (const term of terms) {
            score += countOccurrences(userNormalized, term) * 2;
            score += countOccurrences(answerNormalized, term);
        }
        matches.push({
            round,
            score,
            matched,
            userExcerpt: excerptText(userText, terms, excerptChars),
            assistantExcerpt: excerptText(answerText, terms, excerptChars)
        });
    }
    return matches.sort((left, right) => right.score - left.score || left.round.turn - right.round.turn);
}
export { normalize, queryTerms, countOccurrences, excerptText } from './text.js';
