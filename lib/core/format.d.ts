/**
 * Formatting for `memory_recall` transcripts.
 *
 * @module one-memory/format
 */
import type { Round, RoundsSnapshot } from './rounds.js';
/** Options for one recall transcript. */
export interface FormatRecallOptions {
    /** Session title, when known. */
    title?: string;
    /** Maximum output characters. */
    maxChars: number;
    /** Include the untrusted-background warning (default true). */
    includeWarning?: boolean;
}
/**
 * Render selected rounds as a bounded plain-text transcript. Only the
 * projected user messages and final assistant answer are emitted.
 */
export declare function formatRecall(snapshot: RoundsSnapshot, rounds: readonly Round[], options: FormatRecallOptions): string;
