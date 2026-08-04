/**
 * Executable entry point for the `bit-git-sync` GitHub Action.
 *
 * This module has SIDE EFFECTS on import: it invokes {@link runAction}
 * immediately. That is deliberate — it is the file `scripts/bundle-action.mjs`
 * bundles into `dist/index.js`, which `action.yml` declares as the action's
 * `main`. Importing this component's `index.ts` instead gives you the pure
 * exports (`runAction` + types) with no side effects.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runAction } from './action.js';

/** Runs `cmd` with `args`, inheriting stdio, and resolves with its exit code. */
function exec(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Reads and parses the GitHub Actions event payload JSON file at `path`. */
function readEventFile(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Reads the raw text contents of the file at `path` (e.g. `workspace.jsonc`). */
function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Wires `runAction` to the real process environment, filesystem, a real
 * `process.chdir`, and a real child-process spawn, then sets
 * `process.exitCode` to the result so the action step fails/succeeds
 * accordingly without forcing an abrupt `process.exit()`.
 */
runAction({ env: process.env, readEventFile, readTextFile, exec, chdir: (dir) => process.chdir(dir) })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
