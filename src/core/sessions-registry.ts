/**
 * Unified session registry.
 *
 * Each host keeps its own session ids (`session-<uuid>` in DSH, `ses_…` in
 * opencode). The memory plugin assigns one short, host-neutral id per
 * conversation and stores the mapping, so archive rows, citations, and tool
 * calls all use the same identifier regardless of which agent produced them.
 *
 * @module one-memory/sessions-registry
 */

import { randomBytes } from 'node:crypto';
import { text, type Db } from './db.js';

/** One registered conversation. */
export interface RegisteredSession {
	/** Unified id, for example `m-lq2x9d3f`. */
	id: string;
	/** Producing host. */
	agent: string;
	/** The host's own session id. */
	nativeId: string;
	createdAt: number;
	lastSeen: number;
	title?: string;
}

/** Unified session registry. */
export interface SessionRegistry {
	/** Return the existing unified id for (agent, nativeId), creating one when absent. */
	ensure(agent: string, nativeId: string): RegisteredSession;
	/** Resolve a unified id or any host's native id. */
	resolve(raw: string): RegisteredSession | undefined;
	/** Record activity so listings sort by real use. */
	touch(id: string): void;
	/** Store a display title when the host knows one. */
	setTitle(id: string, title: string): void;
	/** All registered sessions, newest first. */
	list(limit?: number): RegisteredSession[];
	/** The unified id of one session without creating it. */
	find(agent: string, nativeId: string): RegisteredSession | undefined;
}

/** Accepted unified id shape. */
const UNIFIED_ID = /^m-[0-9a-z]{6,24}$/;

/**
 * Build the registry over an open database.
 * @param db - open connection with the schema applied.
 */
export function createSessionRegistry(db: Db): SessionRegistry {
	function rowToSession(row: unknown): RegisteredSession | undefined {
		if (row === null || typeof row !== 'object') return undefined;
		const record = row as Record<string, unknown>;
		const id = text(record['id']);
		const agent = text(record['agent']);
		const nativeId = text(record['native_id']);
		const createdAt = Number(record['created_at'] ?? 0) || 0;
		const lastSeen = Number(record['last_seen'] ?? 0) || 0;
		if (id === undefined || agent === undefined || nativeId === undefined) return undefined;
		const session: RegisteredSession = { id, agent, nativeId, createdAt, lastSeen };
		const title = text(record['title']);
		if (title !== undefined) session.title = title;
		return session;
	}

	function find(agent: string, nativeId: string): RegisteredSession | undefined {
		const row = db
			.prepare('SELECT * FROM memory_session WHERE agent = ? AND native_id = ?')
			.get(agent, nativeId);
		return rowToSession(row);
	}

	function ensure(agent: string, nativeId: string): RegisteredSession {
		const existing = find(agent, nativeId);
		if (existing !== undefined) {
			touch(existing.id);
			return existing;
		}
		const now = Date.now();
		const id = nextId(db, now);
		db.prepare(
			'INSERT INTO memory_session (id, agent, native_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'
		).run(id, agent, nativeId, now, now);
		return { id, agent, nativeId, createdAt: now, lastSeen: now };
	}

	function resolve(raw: string): RegisteredSession | undefined {
		if (raw === '') return undefined;
		if (UNIFIED_ID.test(raw)) {
			const byId = rowToSession(
				db.prepare('SELECT * FROM memory_session WHERE id = ?').get(raw)
			);
			if (byId !== undefined) return byId;
		}
		return rowToSession(
			db
				.prepare('SELECT * FROM memory_session WHERE native_id = ? ORDER BY created_at LIMIT 1')
				.get(raw)
		);
	}

	function touch(id: string): void {
		db.prepare('UPDATE memory_session SET last_seen = ? WHERE id = ?').run(Date.now(), id);
	}

	function setTitle(id: string, title: string): void {
		const trimmed = title.trim();
		if (trimmed === '') return;
		db.prepare('UPDATE memory_session SET title = ? WHERE id = ?').run(trimmed.slice(0, 200), id);
	}

	function list(limit = 100): RegisteredSession[] {
		const rows = db
			.prepare('SELECT * FROM memory_session ORDER BY last_seen DESC LIMIT ?')
			.all(limit);
		const out: RegisteredSession[] = [];
		for (const row of rows) {
			const session = rowToSession(row);
			if (session !== undefined) out.push(session);
		}
		return out;
	}

	return { ensure, resolve, touch, setTitle, list, find };
}

/** Mint a time-ordered unified id; retries on the (unlikely) collision. */
function nextId(db: Db, now: number): string {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const stamp = now.toString(36).slice(-6);
		const random = randomBytes(4).toString('hex');
		const id = `m-${stamp}${random}`;
		const row = db.prepare('SELECT 1 AS hit FROM memory_session WHERE id = ?').get(id);
		if (row === undefined) return id;
	}
	throw new Error('cannot allocate a unified session id');
}
