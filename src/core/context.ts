/**
 * Structural host types used by the agent-memory plugin.
 *
 * The plugin deliberately imports no Harness runtime package: every Host
 * service is reached through `ctx.get()` and described here by the small
 * surface it uses. That keeps installation independent of the Host's module
 * resolution while still sharing the live service instances.
 *
 * @module one-memory/context
 */

/** Minimal logger surface. */
export interface Logger {
	info?(message: string): void;
	warn?(message: string): void;
	debug?(message: string): void;
}

/** One text content block. */
export interface TextBlock {
	readonly type: 'text';
	readonly text: string;
}

/** Any other content block (tool call, reasoning, image, ...). */
export interface OtherBlock {
	readonly type: string;
	readonly [key: string]: unknown;
}

export type ContentBlock = TextBlock | OtherBlock;

/** Durable message source. Merge-extensible in the Host; consumers fall through unknown kinds. */
export interface MessageSource {
	readonly kind?: string;
	readonly form?: string;
	readonly [key: string]: unknown;
}

/** Minimal model-facing message shape. */
export interface MessageLike {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
	readonly content: readonly ContentBlock[];
	readonly source: MessageSource;
}

/** Immutable session header fields this plugin reads. */
export interface SessionHeaderLike {
	readonly id: string;
	readonly createdAt: number;
	readonly cwd?: string;
	readonly parentSession?: string;
	readonly origin?: 'subagent';
	readonly delegationDepth?: number;
}

/** The live session surface this plugin needs. */
export interface SessionLike {
	readonly id: string;
	readonly header: SessionHeaderLike;
	/** Next event sequence number (log length). */
	readonly seq: number;
	deriveMessages(): MessageLike[];
}

/** The live agent surface this plugin needs. */
export interface AgentLike {
	readonly id: string;
	readonly session: SessionLike;
}

/** A user-role message this plugin creates. */
export interface UserMessageLike {
	readonly id: string;
	readonly role: 'user';
	readonly content: ContentBlock[];
	readonly source: MessageSource;
}

/** One committed session event, as returned by the query service. */
export interface SessionEventLike {
	readonly seq: number;
	readonly time: number;
	readonly type: string;
	readonly data: any;
}

/** Lightweight session record returned by `sessionQuery.listSessions()`. */
export interface SessionRecordLike {
	readonly header: SessionHeaderLike;
	readonly live: boolean;
	readonly persisted: boolean;
}

/** Complete raw-log snapshot returned by `sessionQuery.readSession()`. */
export interface SessionLogSnapshotLike {
	readonly session: SessionHeaderLike;
	readonly events: SessionEventLike[];
}

/** Lightweight event record returned by `sessionQuery.listEvents()`. */
export interface SessionEventRecordLike {
	readonly sessionId: string;
	readonly seq: number;
	readonly type: string;
	readonly time: number;
	readonly surface: string;
}

/** One event plus a bounded raw-log window. */
export interface SessionEventWindowLike {
	readonly target: SessionEventLike;
	readonly events: SessionEventLike[];
}

/** Folded session title. */
export interface TitleSnapshotLike {
	readonly title: string;
	readonly eventSeq: number;
	readonly updatedAt: number;
}

/** One batch title observation result. */
export interface TitleObservationLike {
	readonly sessionId: string;
	readonly status: 'fulfilled' | 'rejected';
	readonly value?: { readonly title?: TitleSnapshotLike };
	readonly reason?: unknown;
}

/** One message full-text hit. */
export interface SessionEventSearchHitLike extends SessionEventRecordLike {
	readonly snippet: string;
}

/** One grouped cross-session full-text hit. */
export interface SessionSearchHitLike extends SessionRecordLike {
	readonly bestMatch: SessionEventSearchHitLike;
}

/** One search page. */
export interface SearchPageLike<T> {
	readonly items: readonly T[];
	readonly nextCursor?: unknown;
}

/** Cross-session full-text search request. */
export interface SessionSearchRequestLike {
	readonly query: string;
	readonly sessionFilters?: readonly unknown[];
	readonly eventFilters?: readonly unknown[];
	readonly limit?: number;
	readonly cursor?: unknown;
}

/** Within-session full-text search request. */
export interface SessionEventSearchRequestLike {
	readonly sessionId: string;
	readonly query: string;
	readonly filters?: readonly unknown[];
	readonly limit?: number;
	readonly cursor?: unknown;
}

/** The subset of `ctx.sessionQuery` used by this plugin. */
export interface SessionQueryLike {
	listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>;
	readSession(sessionId: string): Promise<SessionLogSnapshotLike>;
	readTitle(sessionId: string, signal?: AbortSignal): Promise<TitleSnapshotLike | undefined>;
	readTitleSnapshots(
		sessionIds: readonly string[],
		signal?: AbortSignal
	): Promise<TitleObservationLike[]>;
	listEvents(sessionId: string): Promise<SessionEventRecordLike[]>;
	readEvent(request: {
		sessionId: string;
		seq: number;
		before?: number;
		after?: number;
	}): Promise<SessionEventWindowLike>;
	searchSessions(
		request: SessionSearchRequestLike,
		exec?: { readonly signal?: AbortSignal }
	): Promise<SearchPageLike<SessionSearchHitLike>>;
	searchEvents(
		request: SessionEventSearchRequestLike,
		exec?: { readonly signal?: AbortSignal }
	): Promise<SearchPageLike<SessionEventSearchHitLike>>;
}

/** Projection snapshot shape. */
export interface ProjectionSnapshotLike {
	readonly values: { readonly title?: unknown } & Record<string, unknown>;
}

/** The live projection registry. */
export interface SessionProjectionsLike {
	snapshot(session: SessionLike, keys?: readonly string[]): ProjectionSnapshotLike | undefined;
}

/** The persisted projection cache. */
export interface SessionProjectionCacheLike {
	cachedSnapshot(
		header: SessionHeaderLike,
		keys?: readonly string[]
	): ProjectionSnapshotLike | undefined;
}

/** The live session store. */
export interface SessionsLike {
	get(id: string): SessionLike | undefined;
}

/** Tool execution context supplied by the registry. */
export interface ToolRunContextLike {
	readonly agent?: AgentLike;
	readonly signal?: AbortSignal;
}

/** A tool definition accepted by `ctx.tools.register()`. */
export interface ToolDefinitionLike {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly output: {
		readonly schema: Record<string, unknown>;
		render(args: unknown, value: any): ContentBlock[];
	};
	execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
}

/** A child scope handed to `ctx.inject()` once its services are available. */
export interface InjectScope {
	get(name: string): unknown;
	effect(body: () => unknown): unknown;
}

/** The subset of the Cordis plugin context used by this plugin. */
export interface PluginContext {
	readonly logger: Logger;
	get(name: string): unknown;
	readonly tools: {
		register(definition: ToolDefinitionLike): () => void;
	};
	on(
		event: string,
		listener: (...args: any[]) => any,
		options?: { prepend?: boolean }
	): () => void;
	effect(body: () => unknown): unknown;
	/**
	 * Run a callback once the named services are available, on a child scope.
	 * Required for services mounted after this plugin (the HTTP server), which
	 * `get()` cannot see at apply time.
	 */
	inject?(dependencies: readonly string[], callback: (scope: InjectScope) => void): unknown;
}

/** Read one text block, if the block is textual. */
export function blockText(block: ContentBlock): string | undefined {
	if (block.type !== 'text') return undefined;
	const text = (block as { readonly text?: unknown }).text;
	return typeof text === 'string' ? text : undefined;
}

/** Join the text blocks of one content array. */
export function contentText(content: readonly ContentBlock[] | undefined): string {
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		const text = blockText(block);
		if (text !== undefined) parts.push(text);
	}
	return parts.join('\n').trim();
}
