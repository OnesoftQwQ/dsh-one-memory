/**
 * Session-start baseline, incremental memory updates, and the per-turn
 * session/turn context.
 *
 * The listener runs at the first step of every turn. It compares the latest
 * memory revision in the store with the highest revision the model has
 * already seen in this session:
 *
 * - no visible baseline (new session, resume without history, after a
 *   compaction that shadowed it) -> inject the full global memory + key
 *   catalog + the current turn;
 * - a visible baseline but a newer store revision -> inject only the changed
 *   global memory, the added/updated/removed key list, and the current turn;
 * - same revision -> inject only `Current session` / `Current turn`.
 *
 * Because the revision lives in the shared JSON store, a change made by
 * session A is delivered to session B on B's next turn, without a restart.
 *
 * @module one-memory/inject
 */
import { randomUUID } from 'node:crypto';
/**
 * Install the `agent/pre-step` listener.
 */
export function installInjection(ctx, store, registry, config) {
    if (!config.injectGlobal)
        return;
    const handler = async (payload, next) => {
        const decision = await next();
        if (decision.kind !== 'enter')
            return decision;
        const agent = payload.agent;
        if (agent === undefined)
            return decision;
        if (!config.injectGlobalInSubagents && agent.session.header.origin === 'subagent') {
            return decision;
        }
        const step = typeof payload.step === 'number' ? payload.step : 1;
        if (step !== 1)
            return decision;
        if (decision.messages.length === 0)
            return decision;
        const nativeId = agent.session.id;
        const registered = registry.find('dsh', nativeId) ?? registry.ensure('dsh', nativeId);
        const sessionId = registered.id;
        const turn = turnNumber(payload.turn);
        const visible = findVisibleMemory(agent.session.deriveMessages());
        const currentRevision = store.snapshot().revision;
        if (visible === undefined || !visible.baseline || visible.revision > currentRevision) {
            const baseline = store.render(sessionId);
            if (baseline !== undefined) {
                return insertAfterClaimed(decision, payload.messages, baselineMessage(baseline, turn));
            }
        }
        else if (visible.revision < currentRevision) {
            const delta = store.changesSince(visible.revision);
            const rendered = store.renderDelta(delta);
            if (rendered !== undefined) {
                return insertAfterClaimed(decision, payload.messages, deltaMessage(rendered, sessionId, turn));
            }
        }
        return insertAfterClaimed(decision, payload.messages, contextMessage(sessionId, turn, currentRevision));
    };
    ctx.effect(() => ctx.on('agent/pre-step', handler, { prepend: true }));
}
function turnNumber(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function baselineMessage(rendered, turn) {
    const text = turn === undefined ? rendered.text : `${rendered.text}\n\nCurrent turn: ${turn}`;
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: {
            kind: 'agent-memory',
            form: 'snapshot',
            version: 1,
            memoryKind: 'baseline',
            revision: rendered.revision,
            ...(turn === undefined ? {} : { turn }),
            catalogVersion: rendered.version,
            sections: rendered.sections
        }
    };
}
function deltaMessage(rendered, sessionId, turn) {
    const context = [`Current session: ${sessionId}`];
    if (turn !== undefined)
        context.push(`Current turn: ${turn}`);
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `${rendered.text}\n\n${context.join('\n')}` }],
        source: {
            kind: 'agent-memory',
            form: 'snapshot',
            version: 1,
            memoryKind: 'delta',
            revision: rendered.revision,
            fromRevision: rendered.fromRevision,
            ...(turn === undefined ? {} : { turn }),
            sections: rendered.sections
        }
    };
}
function contextMessage(sessionId, turn, revision) {
    const lines = [`Current session: ${sessionId}`];
    if (turn !== undefined)
        lines.push(`Current turn: ${turn}`);
    const summary = `memory context: ${sessionId}${turn === undefined ? '' : `, turn ${turn}`}`;
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: lines.join('\n') }],
        source: {
            kind: 'agent-memory',
            form: 'notice',
            version: 1,
            memoryKind: 'context',
            revision,
            ...(turn === undefined ? {} : { turn }),
            summary: summary.slice(0, 120)
        }
    };
}
function insertAfterClaimed(decision, claimed, message) {
    const offered = claimed ?? [];
    const lastClaimed = decision.messages.findLastIndex((candidate) => offered.includes(candidate));
    const index = lastClaimed >= 0 ? lastClaimed + 1 : decision.messages.length;
    return { ...decision, messages: decision.messages.toSpliced(index, 0, message) };
}
function findVisibleMemory(messages) {
    let found = false;
    let baseline = false;
    let revision = 0;
    for (const message of messages) {
        if (message.role !== 'user')
            continue;
        const source = message.source;
        if (source.kind !== 'agent-memory' || source.form !== 'snapshot')
            continue;
        found = true;
        if (source['memoryKind'] !== 'delta')
            baseline = true;
        const rawRevision = source['revision'];
        if (typeof rawRevision === 'number' &&
            Number.isSafeInteger(rawRevision) &&
            rawRevision >= 0) {
            revision = Math.max(revision, rawRevision);
        }
    }
    return found ? { baseline, revision } : undefined;
}
