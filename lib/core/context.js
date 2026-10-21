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
/** Read one text block, if the block is textual. */
export function blockText(block) {
    if (block.type !== 'text')
        return undefined;
    const text = block.text;
    return typeof text === 'string' ? text : undefined;
}
/** Join the text blocks of one content array. */
export function contentText(content) {
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        const text = blockText(block);
        if (text !== undefined)
            parts.push(text);
    }
    return parts.join('\n').trim();
}
