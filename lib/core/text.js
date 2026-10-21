/**
 * Framework-neutral literal-text helpers shared by the round projection and
 * the archive.
 *
 * @module one-memory/text
 */
/** Lower-case and collapse whitespace. */
export function normalize(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Split a query into literal terms. */
export function queryTerms(query) {
    return normalize(query)
        .split(' ')
        .filter((term) => term.length > 0);
}
/** Count non-overlapping term occurrences. */
export function countOccurrences(haystack, needle) {
    if (needle === '')
        return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index >= 0) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
/** Bounded excerpt around the first matching term. */
export function excerptText(text, terms, maxChars) {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean === '')
        return '';
    if (clean.length <= maxChars)
        return clean;
    const lower = clean.toLowerCase();
    let index = -1;
    for (const term of terms) {
        const found = lower.indexOf(term);
        if (found >= 0) {
            index = found;
            break;
        }
    }
    if (index < 0)
        return `${clean.slice(0, maxChars)}…`;
    const half = Math.floor(maxChars / 2);
    const start = Math.max(0, index - half);
    const end = Math.min(clean.length, start + maxChars);
    return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}
