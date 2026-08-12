/**
 * Public entry point for embedding (desktop wrapper, tests, other scripts).
 * The CLI and the MCP server import these very modules — there is no second
 * implementation.
 */

export * as config from './config.mjs';
export * as store from './store.mjs';
export * as generate from './generate.mjs';
export * as provider from './provider.mjs';
export { PROVIDER } from './provider.mjs';
export { GcvError, EXIT } from './errors.mjs';
