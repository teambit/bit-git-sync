import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Repo root, derived from this file's location so cwd never matters. */
export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Path of the committed bundle that `action.yml` declares as `main`. */
export const bundlePath = join(repoRoot, 'dist', 'index.js');

/**
 * Shared esbuild config for the action bundle, exported so
 * `scripts/verify-bundle.mjs` can rebuild with the exact same settings.
 *
 * `format: 'esm'` is REQUIRED. The root package.json declares
 * `"type": "module"`, so Node parses `dist/index.js` as ESM; emitting
 * esbuild's default (CJS) produces a bundle whose `module.exports = ...`
 * prologue throws `ReferenceError: module is not defined in ES module scope`
 * the moment GitHub Actions loads it. `npm run verify-bundle` guards against
 * that regressing.
 *
 * The entry point is `run.ts`, not the component's `index.ts`: `index.ts` is
 * the component's pure, side-effect-free export surface; `run.ts` is the
 * side-effecting executable that actually invokes `runAction`.
 */
export const bundleOptions = {
  entryPoints: [join(repoRoot, 'git-sync/git-sync/action/run.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  absWorkingDir: repoRoot,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await build({ ...bundleOptions, outfile: bundlePath });
}
