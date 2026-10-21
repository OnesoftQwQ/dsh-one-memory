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
import { type SessionEventLike, type SessionHeaderLike, type SessionQueryLike } from './context.js';
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
/**
 * Project raw events into rounds. Events before the first `turn/start` are
 * ignored. Duplicate turn blocks (resume) are merged by turn number.
 * @param events - raw session events, any order.
 */
export declare function buildRounds(events: readonly SessionEventLike[]): Round[];
/** Read and project one session. */
export declare function loadRounds(sessionQuery: SessionQueryLike, sessionId: string): Promise<RoundsSnapshot>;
/** Thrown when a requested turn is absent from the session. */
export declare class RoundNotFoundError extends Error {
    readonly available: readonly number[];
    constructor(turn: number, available: readonly number[]);
}
/**
 * Select one turn plus `before`/`after` adjacent turns.
 * @throws {RoundNotFoundError} when the turn is absent.
 */
export declare function selectRounds(rounds: readonly Round[], turn: number, before: number, after: number): Round[];
/** Find the round containing a raw event seq. */
export declare function roundForSeq(rounds: readonly Round[], seq: number): Round | undefined;
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
export declare function searchRounds(rounds: readonly Round[], query: string, excerptChars?: number): RoundMatch[];
export { normalize, queryTerms, countOccurrences, excerptText } from './text.js';
