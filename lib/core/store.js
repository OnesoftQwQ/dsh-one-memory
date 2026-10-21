/**
 * SQLite-backed memory store.
 *
 * One file holds the curated memory (global + key-value), its monotonic
 * revision, and deletion tombstones, so every write is one transaction and a
 * second host process reading the same file sees a consistent state. A legacy
 * `memory.json` is imported once when the database is first created.
 *
 * @module one-memory/store
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ensureSchema, integer, text, transaction } from './db.js';
/** Thrown when the ordinary-key budget is exhausted. */
export class MemoryLimitError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemoryLimitError';
    }
}
/** The reserved global-memory key. */
export const GLOBAL_KEY = '@global';
const ENTRY_COLUMNS = 'key, value, description, source_session, source_turn, source_conversation, revision, created_revision, created_at, updated_at';
/**
 * Open the store, creating the schema on first use.
 * @param options - database path, limits, and optional legacy import.
 */
export function createMemoryStore(options) {
    const db = options.db;
    const file = db.path;
    const warn = options.warn ?? (() => { });
    const maxDeltaChars = options.maxDeltaChars ?? 6000;
    const deltaValueChars = options.deltaValueChars ?? 600;
    ensureSchema(db);
    if (options.legacyFile !== undefined && options.legacyFile !== '') {
        importLegacy(db, options.legacyFile, warn);
    }
    function readRevision() {
        return Number(readMeta(db, 'revision') ?? '0') || 0;
    }
    function writeRevision(value) {
        writeMeta(db, 'revision', String(value));
    }
    function snapshot() {
        const revision = readRevision();
        const globalRow = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM memory_entry WHERE key = ?`).get(GLOBAL_KEY);
        const rows = db
            .prepare('SELECT key, description FROM memory_entry WHERE key <> ? ORDER BY key')
            .all(GLOBAL_KEY);
        const catalog = [];
        for (const row of rows) {
            const record = row;
            const key = text(record['key']);
            if (key === undefined)
                continue;
            const item = { key };
            const description = text(record['description']);
            if (description !== undefined && description !== '')
                item.description = description;
            catalog.push(item);
        }
        const global = globalRow === undefined ? undefined : rowToEntry(globalRow);
        return { revision, global, catalog, version: catalogVersion(global, catalog) };
    }
    function entries() {
        const rows = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM memory_entry ORDER BY key`).all();
        const out = [];
        for (const row of rows) {
            const entry = rowToEntry(row);
            const record = row;
            const key = text(record['key']);
            if (entry === undefined || key === undefined)
                continue;
            const view = {
                key,
                value: entry.value,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt
            };
            if (entry.description !== undefined)
                view.description = entry.description;
            if (entry.revision !== undefined)
                view.revision = entry.revision;
            out.push(view);
        }
        return out;
    }
    function get(key) {
        const row = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM memory_entry WHERE key = ?`).get(key);
        return row === undefined ? undefined : rowToEntry(row);
    }
    function set(key, input) {
        return transaction(db, () => {
            const existing = get(key);
            const nextDescription = key === GLOBAL_KEY
                ? existing?.description
                : input.description !== undefined
                    ? (input.description ?? undefined)
                    : existing?.description;
            const nextSession = input.sourceSession !== undefined
                ? (input.sourceSession ?? undefined)
                : existing?.sourceSession;
            const nextTurn = input.sourceTurn !== undefined ? (input.sourceTurn ?? undefined) : existing?.sourceTurn;
            const nextConversation = input.sourceConversation !== undefined
                ? (input.sourceConversation ?? undefined)
                : existing?.sourceConversation;
            const revision = readRevision();
            if (existing !== undefined &&
                existing.value === input.value &&
                existing.description === nextDescription &&
                existing.sourceSession === nextSession &&
                existing.sourceTurn === nextTurn &&
                existing.sourceConversation === nextConversation) {
                return { created: false, entry: existing, revision };
            }
            if (existing === undefined && key !== GLOBAL_KEY) {
                const row = db
                    .prepare('SELECT COUNT(*) AS n FROM memory_entry WHERE key <> ?')
                    .get(GLOBAL_KEY);
                const count = Number(row?.n ?? 0);
                if (count >= options.maxEntries) {
                    throw new MemoryLimitError(`memory is full (${count}/${options.maxEntries} keys); delete or consolidate a key first`);
                }
            }
            const next = revision + 1;
            const now = Date.now();
            const entry = existing === undefined
                ? { value: input.value, createdAt: now, updatedAt: now, revision: next, createdRevision: next }
                : {
                    ...existing,
                    value: input.value,
                    updatedAt: now,
                    revision: next,
                    createdRevision: existing.createdRevision ?? 0
                };
            if (nextDescription === undefined)
                delete entry.description;
            else
                entry.description = nextDescription;
            if (nextSession === undefined)
                delete entry.sourceSession;
            else
                entry.sourceSession = nextSession;
            if (nextTurn === undefined)
                delete entry.sourceTurn;
            else
                entry.sourceTurn = nextTurn;
            if (nextConversation === undefined)
                delete entry.sourceConversation;
            else
                entry.sourceConversation = nextConversation;
            db.prepare(`INSERT INTO memory_entry (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
					value = excluded.value,
					description = excluded.description,
					source_session = excluded.source_session,
					source_turn = excluded.source_turn,
					source_conversation = excluded.source_conversation,
					revision = excluded.revision,
					updated_at = excluded.updated_at`).run(key, entry.value, entry.description ?? null, entry.sourceSession ?? null, entry.sourceTurn ?? null, entry.sourceConversation ?? null, entry.revision ?? next, entry.createdRevision ?? 0, entry.createdAt, entry.updatedAt);
            db.prepare('DELETE FROM memory_tombstone WHERE key = ?').run(key);
            writeRevision(next);
            return { created: existing === undefined, entry, revision: next };
        });
    }
    function remove(key) {
        return transaction(db, () => {
            const existing = get(key);
            if (existing === undefined)
                return false;
            const next = readRevision() + 1;
            db.prepare('DELETE FROM memory_entry WHERE key = ?').run(key);
            db.prepare('INSERT INTO memory_tombstone (key, revision) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision').run(key, next);
            writeRevision(next);
            return true;
        });
    }
    function revision() {
        return readRevision();
    }
    function changesSince(fromRevision) {
        const from = Math.max(0, Math.trunc(fromRevision));
        const current = readRevision();
        if (from >= current) {
            return {
                fromRevision: from,
                revision: current,
                global: undefined,
                globalRemoved: false,
                entries: [],
                removed: []
            };
        }
        const globalRow = db
            .prepare(`SELECT ${ENTRY_COLUMNS} FROM memory_entry WHERE key = ? AND revision > ?`)
            .get(GLOBAL_KEY, from);
        const global = globalRow === undefined ? undefined : rowToEntry(globalRow);
        const globalTombstone = db
            .prepare('SELECT revision FROM memory_tombstone WHERE key = ? AND revision > ?')
            .get(GLOBAL_KEY, from);
        const globalRemoved = global === undefined && globalTombstone !== undefined && Number(globalTombstone.revision ?? 0) > from;
        const rows = db
            .prepare(`SELECT ${ENTRY_COLUMNS} FROM memory_entry WHERE key <> ? AND revision > ? ORDER BY revision, key`)
            .all(GLOBAL_KEY, from);
        const changes = [];
        for (const row of rows) {
            const entry = rowToEntry(row);
            const record = row;
            const key = text(record['key']);
            if (entry === undefined || key === undefined)
                continue;
            changes.push({ key, entry, kind: (entry.createdRevision ?? 0) > from ? 'added' : 'updated' });
        }
        const tombstones = db
            .prepare('SELECT key, revision FROM memory_tombstone WHERE key <> ? AND revision > ? ORDER BY revision, key')
            .all(GLOBAL_KEY, from);
        const removed = tombstones
            .map((row) => text(row.key))
            .filter((key) => key !== undefined);
        return { fromRevision: from, revision: current, global, globalRemoved, entries: changes, removed };
    }
    function version() {
        return snapshot().version;
    }
    function render(sessionId) {
        const current = snapshot();
        const globalText = current.global?.value.trim() ?? '';
        const catalogText = renderCatalog(current.catalog, options.maxCatalogChars);
        if (globalText === '' && catalogText === '')
            return undefined;
        const sections = [];
        const blocks = [];
        if (globalText !== '') {
            sections.push({ name: 'global-memory', text: globalText });
            blocks.push(`<global-memory>\n${globalText}\n</global-memory>`);
        }
        if (catalogText !== '') {
            sections.push({ name: 'memory-keys', text: catalogText });
            blocks.push(`<memory-keys>\n${catalogText}\n</memory-keys>`);
        }
        if (sessionId !== undefined && sessionId !== '') {
            blocks.push(`Current session: ${sessionId}`);
        }
        return { text: blocks.join('\n\n'), sections, version: current.version, revision: current.revision };
    }
    function renderDelta(delta) {
        if (delta.revision <= delta.fromRevision)
            return undefined;
        const sections = [];
        const blocks = [];
        const globalText = delta.global?.value.trim() ?? '';
        if (globalText !== '') {
            sections.push({ name: 'global-memory', text: globalText });
            blocks.push(`This global memory block replaces the earlier global memory.\n\n<global-memory>\n${globalText}\n</global-memory>`);
        }
        else if (delta.globalRemoved) {
            sections.push({ name: 'global-memory', text: '(cleared)' });
            blocks.push('<global-memory>\n(cleared)\n</global-memory>');
        }
        const lines = [];
        for (const change of delta.entries) {
            const prefix = change.kind === 'added' ? '+' : '~';
            const description = change.entry.description === undefined || change.entry.description === ''
                ? ''
                : ` — ${change.entry.description}`;
            const value = boundedValue(change.entry.value, deltaValueChars);
            const valueLines = value.split('\n');
            if (valueLines.length === 1) {
                lines.push(`${prefix} ${change.key}${description}: ${valueLines[0] ?? ''}`);
            }
            else {
                lines.push(`${prefix} ${change.key}${description}:`);
                for (const line of valueLines)
                    lines.push(`  ${line}`);
            }
        }
        for (const key of delta.removed)
            lines.push(`- ${key}`);
        if (lines.length > 0) {
            const header = 'Memory changes since the last update:';
            const body = capLines(lines, Math.max(0, maxDeltaChars - header.length - 32), 'changes');
            sections.push({ name: 'memory-changes', text: body });
            blocks.push(`${header}\n<memory-changes>\n${body}\n</memory-changes>`);
        }
        if (blocks.length === 0)
            return undefined;
        const text = blocks.join('\n\n');
        return {
            text: text.length <= maxDeltaChars ? text : `${text.slice(0, maxDeltaChars)}\n\n[...truncated]`,
            sections,
            revision: delta.revision,
            fromRevision: delta.fromRevision
        };
    }
    return {
        path: file,
        snapshot,
        entries,
        revision,
        get,
        set,
        delete: remove,
        changesSince,
        render,
        renderDelta,
        version
    };
}
function readMeta(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return text(row?.value);
}
function writeMeta(db, key, value) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function rowToEntry(row) {
    if (row === null || typeof row !== 'object')
        return undefined;
    const record = row;
    const value = text(record['value']);
    if (value === undefined)
        return undefined;
    const entry = {
        value,
        createdAt: integer(record['created_at']) ?? 0,
        updatedAt: integer(record['updated_at']) ?? 0,
        revision: integer(record['revision']) ?? 0,
        createdRevision: integer(record['created_revision']) ?? 0
    };
    const description = text(record['description']);
    if (description !== undefined)
        entry.description = description;
    const session = text(record['source_session']);
    if (session !== undefined)
        entry.sourceSession = session;
    const turn = integer(record['source_turn']);
    if (turn !== undefined)
        entry.sourceTurn = turn;
    const conversation = text(record['source_conversation']);
    if (conversation !== undefined)
        entry.sourceConversation = conversation;
    return entry;
}
function catalogVersion(global, catalog) {
    const hash = createHash('sha1');
    hash.update(JSON.stringify({ global: global?.value ?? '', catalog }));
    return hash.digest('hex');
}
function renderCatalog(catalog, maxChars) {
    if (catalog.length === 0)
        return '';
    const lines = [];
    let used = 0;
    let shown = 0;
    for (const item of catalog) {
        const line = item.description === undefined || item.description === ''
            ? `- ${item.key}`
            : `- ${item.key} — ${item.description}`;
        const cost = line.length + (lines.length === 0 ? 0 : 1);
        if (used + cost > maxChars)
            break;
        lines.push(line);
        used += cost;
        shown += 1;
    }
    const hidden = catalog.length - shown;
    if (hidden > 0)
        lines.push(`- ... (${hidden} more keys; call memory_get() to list all)`);
    return lines.join('\n');
}
function capLines(lines, maxChars, label) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
        const cost = line.length + (kept.length === 0 ? 0 : 1);
        if (used + cost > maxChars)
            break;
        kept.push(line);
        used += cost;
    }
    const hidden = lines.length - kept.length;
    if (hidden > 0)
        kept.push(`- ... (${hidden} more ${label}; use memory_get(key) for details)`);
    return kept.join('\n');
}
function boundedValue(value, maxChars) {
    const trimmed = value.trim();
    if (trimmed.length <= maxChars)
        return trimmed;
    return `${trimmed.slice(0, maxChars)}… (use memory_get(key))`;
}
/**
 * Import the pre-0.3 `memory.json` once. The legacy file is never modified, so
 * a downgrade keeps working.
 */
function importLegacy(db, legacyFile, warn) {
    if (!existsSync(legacyFile))
        return;
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_entry').get();
    if (Number(row?.n ?? 0) > 0)
        return;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(legacyFile, 'utf8'));
    }
    catch (error) {
        warn(`[one-memory] cannot import legacy memory ${legacyFile}: ${String(error)}`);
        return;
    }
    const record = parsed;
    if (record.entries === null || typeof record.entries !== 'object')
        return;
    let revision = Number(record.revision ?? 0) || 0;
    transaction(db, () => {
        for (const [key, raw] of Object.entries(record.entries)) {
            if (raw === null || typeof raw !== 'object')
                continue;
            const entry = raw;
            if (typeof entry['value'] !== 'string')
                continue;
            const entryRevision = Number(entry['revision'] ?? 0) || 0;
            revision = Math.max(revision, entryRevision);
            db.prepare(`INSERT INTO memory_entry (${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(key) DO NOTHING`).run(key, entry['value'], typeof entry['description'] === 'string' ? entry['description'] : null, typeof entry['sourceSession'] === 'string' ? entry['sourceSession'] : null, typeof entry['sourceTurn'] === 'number' ? entry['sourceTurn'] : null, typeof entry['sourceConversation'] === 'string' ? entry['sourceConversation'] : null, entryRevision, Number(entry['createdRevision'] ?? 0) || 0, Number(entry['createdAt'] ?? Date.now()) || Date.now(), Number(entry['updatedAt'] ?? Date.now()) || Date.now());
        }
        if (record.tombstones !== null && typeof record.tombstones === 'object') {
            for (const [key, raw] of Object.entries(record.tombstones)) {
                const removedAt = Number(raw ?? 0) || 0;
                if (removedAt <= 0)
                    continue;
                revision = Math.max(revision, removedAt);
                db.prepare('INSERT INTO memory_tombstone (key, revision) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision').run(key, removedAt);
            }
        }
        const current = Math.max(Number(readMeta(db, 'revision') ?? 0) || 0, revision);
        writeMeta(db, 'revision', String(current));
    });
    warn(`[one-memory] imported legacy memory from ${legacyFile}`);
}
