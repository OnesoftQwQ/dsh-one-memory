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

import {
	contentText,
	type SessionEventLike,
	type SessionHeaderLike,
	type SessionQueryLike
} from './context.js';
import {
	countOccurrences,
	excerptText,
	normalize,
	queryTerms
} from './text.js';

/** One projected conversation round. */
export interface Round {
	/** DSH turn number (1-based). */
	turn: number;
	/** First raw event seq of the turn. */
	startSeq: number;
	/** Last raw event seq of the turn. */
	endSeq: number;
	/** Turn start timestamp (Unix epoch ms). */
	time: number;
	/** Direct user messages, in order (usually one; steering may add more). */
	users: string[];
	/** Raw seqs of the direct user messages. */
	userSeqs: number[];
	/** Final assistant text, or empty when the turn has no textual answer. */
	answer: string;
	/** Raw seq of the assistant message that produced {@link answer}. */
	answerSeq?: number;
	/** Turn end reason, when the log closed the turn. */
	endReason?: string;
	/** Whether the turn has no `turn/end` yet. */
	inProgress: boolean;
}

/** One session's projected rounds. */
export interface RoundsSnapshot {
	header: SessionHeaderLike;
	rounds: Round[];
}

interface TurnGroup {
	turn: number;
	startSeq: number;
	endSeq: number;
	time: number;
	events: SessionEventLike[];
	endReason?: string;
	inProgress: boolean;
}

const TURN_START = 'turn/start';
const TURN_END = 'turn/end';

/**
 * Project raw events into rounds. Events before the first `turn/start` are
 * ignored. Duplicate turn blocks (resume) are merged by turn number.
 * @param events - raw session events, any order.
 */
export function buildRounds(events: readonly SessionEventLike[]): Round[] {
	const ordered = [...events].sort((left, right) => left.seq - right.seq);
	const groups: TurnGroup[] = [];
	let current: TurnGroup | undefined;
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
		if (current === undefined) continue;
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
	const merged = new Map<number, TurnGroup>();
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

function projectGroup(group: TurnGroup): Round {
	const users: string[] = [];
	const userSeqs: number[] = [];
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
	let answerSeq: number | undefined;
	let fallback: { text: string; seq: number } | undefined;
	for (const event of group.events) {
		if (event.type !== 'assistant/message') continue;
		const text = contentText(event.data?.message?.content);
		if (text === '') continue;
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
	const round: Round = {
		turn: group.turn,
		startSeq: group.startSeq,
		endSeq: group.endSeq,
		time: group.time,
		users,
		userSeqs,
		answer,
		inProgress: group.inProgress
	};
	if (answerSeq !== undefined) round.answerSeq = answerSeq;
	if (group.endReason !== undefined) round.endReason = group.endReason;
	return round;
}

function isTurnNumber(value: unknown): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function reasonText(reason: unknown): string | undefined {
	if (typeof reason === 'string') return reason;
	if (reason !== null && typeof reason === 'object') {
		const value = reason as { readonly kind?: unknown; readonly error?: unknown };
		if (typeof value.kind === 'string') {
			if (
				value.kind === 'error' &&
				value.error !== null &&
				typeof value.error === 'object' &&
				typeof (value.error as { readonly message?: unknown }).message === 'string'
			) {
				return `error: ${(value.error as { readonly message: string }).message}`;
			}
			return value.kind;
		}
	}
	return undefined;
}

/** Read and project one session. */
export async function loadRounds(
	sessionQuery: SessionQueryLike,
	sessionId: string
): Promise<RoundsSnapshot> {
	const snapshot = await sessionQuery.readSession(sessionId);
	return { header: snapshot.session, rounds: buildRounds(snapshot.events) };
}

/** Thrown when a requested turn is absent from the session. */
export class RoundNotFoundError extends Error {
	readonly available: readonly number[];

	constructor(turn: number, available: readonly number[]) {
		const range =
			available.length === 0
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
export function selectRounds(
	rounds: readonly Round[],
	turn: number,
	before: number,
	after: number
): Round[] {
	const index = rounds.findIndex((round) => round.turn === turn);
	if (index < 0) throw new RoundNotFoundError(turn, rounds.map((round) => round.turn));
	const start = Math.max(0, index - Math.max(0, before));
	const end = Math.min(rounds.length, index + Math.max(0, after) + 1);
	return rounds.slice(start, end);
}

/** Find the round containing a raw event seq. */
export function roundForSeq(rounds: readonly Round[], seq: number): Round | undefined {
	return rounds.find((round) => seq >= round.startSeq && seq <= round.endSeq);
}

/** A literal query match over one projected round. */
export interface RoundMatch {
	round: Round;
	score: number;
	matched: 'user' | 'assistant' | 'both';
	userExcerpt: string;
	assistantExcerpt: string;
}

/**
 * Literal, case-insensitive, whitespace-flexible search over the projected
 * user and final-answer text of every round. All whitespace-separated query
 * terms must occur somewhere in the round.
 */
export function searchRounds(
	rounds: readonly Round[],
	query: string,
	excerptChars = 180
): RoundMatch[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return [];
	const matches: RoundMatch[] = [];
	for (const round of rounds) {
		const userText = round.users.join('\n');
		const answerText = round.answer;
		const userNormalized = normalize(userText);
		const answerNormalized = normalize(answerText);
		const combined = `${userNormalized}\n${answerNormalized}`;
		if (!terms.every((term) => combined.includes(term))) continue;
		const userAll = terms.every((term) => userNormalized.includes(term));
		const answerAll = terms.every((term) => answerNormalized.includes(term));
		const matched: RoundMatch['matched'] =
			userAll && answerAll ? 'both' : userAll ? 'user' : answerAll ? 'assistant' : 'both';
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
	return matches.sort(
		(left, right) => right.score - left.score || left.round.turn - right.round.turn
	);
}

export { normalize, queryTerms, countOccurrences, excerptText } from './text.js';
