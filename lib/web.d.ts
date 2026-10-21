/**
 * Same-origin HTTP API for the memory management page.
 *
 * The page is a browser plugin and cannot reach the Host store directly, so
 * the Host half registers three routes on `ctx.webServer`:
 *
 *   GET  /one-memory/state   -> { revision, path, maxEntries, global, entries }
 *   POST /one-memory/save    -> { key, value, description? }
 *   POST /one-memory/delete  -> { key }
 *
 * The routes share the plugin's store instance, so a save from the page bumps
 * the same revision the model's tools use and therefore reaches every live
 * session through the incremental injection path.
 *
 * @module one-memory/web
 */
import type { PluginContext } from './core/context.js';
import type { MemoryConfig } from './core/config.js';
import { type MemoryStore } from './core/store.js';
/**
 * Install the management routes when the deployment serves HTTP.
 * @param ctx - plugin context.
 * @param store - the shared memory store.
 * @param config - resolved plugin configuration.
 */
export declare function installWeb(ctx: PluginContext, store: MemoryStore, config: MemoryConfig): void;
