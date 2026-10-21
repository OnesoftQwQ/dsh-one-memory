/**
 * Framework-neutral literal-text helpers shared by the round projection and
 * the archive.
 *
 * @module one-memory/text
 */
/** Lower-case and collapse whitespace. */
export declare function normalize(text: string): string;
/** Split a query into literal terms. */
export declare function queryTerms(query: string): string[];
/** Count non-overlapping term occurrences. */
export declare function countOccurrences(haystack: string, needle: string): number;
/** Bounded excerpt around the first matching term. */
export declare function excerptText(text: string, terms: readonly string[], maxChars: number): string;
