/**
 * Public, side-effect-free surface of this component. Importing it never runs
 * the action — the executable entry point (which invokes `runAction` on
 * import, and is what `scripts/bundle-action.mjs` bundles into
 * `dist/index.js`) is `./run.ts`.
 */
export { runAction } from './action.js';
export type { ActionDeps } from './action.js';
